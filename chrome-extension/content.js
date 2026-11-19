/**
 * Universal Webchat Agent Bridge - Content Script
 * Supports: Gemini (gemini.google.com), ChatGPT (chatgpt.com, chat.openai.com), Claude (claude.ai)
 * Connects to local CLI orchestrator via ws://localhost:8765
 */

(() => {
  const WS_URL = 'ws://localhost:8765';
  let socket = null;
  let isGenerating = false;
  let safeModeActive = true;
  const reconnectInterval = 2000;
  let lastReportedModel = '';

  // 1. Platform Detection
  function getPlatform() {
    const host = window.location.hostname;
    if (host.includes('gemini.google.com')) return 'Gemini';
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'ChatGPT';
    if (host.includes('claude.ai')) return 'Claude';
    return 'WebChat';
  }

  const platform = getPlatform();

  // 2. Modular Platform DOM Adapters
  const Adapters = {
    Gemini: {
      getModelName() {
        // 1. Direct search for any button or label showing Hydrogen (Low/Medium/High) or Argon in the input container or header
        const allButtonsAndChips = document.querySelectorAll(
          'button, [role="button"], span.model-title, [data-test-id*="model"], .mat-mdc-menu-trigger'
        );
        for (const el of allButtonsAndChips) {
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          if (/hydrogen\s*(low|medium|high)/i.test(text)) {
            const match = text.match(/hydrogen\s*(low|medium|high)/i);
            const level = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
            return `Hydrogen ${level}`;
          }
          if (/hydrogen/i.test(text) && text.length < 35) {
            return text.split('\n')[0].trim() || 'Gemini 4 Hydrogen';
          }
          if (/argon/i.test(text) && text.length < 35) {
            return text.split('\n')[0].trim() || 'Gemini 4 Argon';
          }
        }

        const candidateSelectors = [
          'button[data-test-id="model-selector-button"]',
          'button[data-test-id="bard-mode-menu-button"]',
          'button[aria-label*="Hydrogen" i]',
          'button[aria-label*="Argon" i]',
          'button[aria-label*="model" i]',
          '[data-test-id*="model-selector"]',
          '[data-test-id="selected-model-name"]',
          '.model-pill',
          'button span.model-title',
          'bard-mode-switcher button',
          'model-switcher button',
          'header button[aria-haspopup="menu"]',
          'nav button[aria-haspopup="menu"]',
          '.mat-mdc-menu-trigger'
        ];

        for (const selector of candidateSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            const rawText = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
            if (/hydrogen/i.test(rawText)) {
              return 'Gemini 4 Hydrogen';
            }
            if (/argon/i.test(rawText)) {
              return 'Gemini 4 Argon';
            }
            if (rawText) {
              const firstLine = rawText.split('\n')[0].trim();
              if (firstLine && !/^(switch|select|choose|menu)/i.test(firstLine)) {
                return firstLine;
              }
            }
          }
        }

        // Header and top-bar inspection for Chrome PWA and standalone windows
        const headerElements = document.querySelectorAll(
          'header, [role="banner"], .top-bar, nav, bard-mode-switcher, bard-mode-menu, [data-test-id="top-bar"]'
        );
        for (const container of headerElements) {
          const text = (container.innerText || container.textContent || '').trim();
          if (/gemini\s*4\s*hydrogen|hydrogen/i.test(text)) {
            return 'Gemini 4 Hydrogen';
          }
          if (/gemini\s*4\s*argon|argon/i.test(text)) {
            return 'Gemini 4 Argon';
          }
        }

        // Inspection across top-level buttons or chips in header
        const topButtons = document.querySelectorAll('header button, nav button, [role="banner"] button, div[role="button"]');
        for (const btn of topButtons) {
          const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
          if (/hydrogen/i.test(label)) {
            return 'Gemini 4 Hydrogen';
          }
          if (/argon/i.test(label)) {
            return 'Gemini 4 Argon';
          }
        }
        return 'Gemini Web';
      },
      findInputBox() {
        return (
          document.querySelector('rich-textarea div[role="textbox"]') ||
          document.querySelector('div[role="textbox"][contenteditable="true"]') ||
          document.querySelector('.ql-editor[contenteditable="true"]') ||
          document.querySelector('rich-textarea [contenteditable="true"]') ||
          document.querySelector('textarea')
        );
      },
      findSendButton() {
        return (
          document.querySelector('button[aria-label*="Send" i]') ||
          document.querySelector('button[aria-label*="ส่ง" i]') ||
          document.querySelector('button[data-test-id*="send"]') ||
          document.querySelector('button.send-button') ||
          document.querySelector('.send-button-container button') ||
          document.querySelector('button:has(mat-icon[fonticon="send"])') ||
          document.querySelector('button:has(span[data-test-id*="send"])') ||
          document.querySelector('div[role="button"][aria-label*="Send" i]') ||
          document.querySelector('div[role="button"][aria-label*="ส่ง" i]')
        );
      },
      findStopButton() {
        return (
          document.querySelector('button[aria-label*="Stop" i]') ||
          document.querySelector('button[aria-label*="หยุด" i]') ||
          document.querySelector('button.stop-button') ||
          document.querySelector('.stop-button-container button') ||
          document.querySelector('button:has(mat-icon[fonticon="stop"])')
        );
      },
      getLatestResponseText() {
        const responses = document.querySelectorAll(
          'model-response, .model-response-text, message-content, [data-message-id], model-turn'
        );
        if (responses.length > 0) {
          const last = responses[responses.length - 1];
          const markdownBody = last.querySelector('.markdown') || last;
          return (markdownBody.innerText || markdownBody.textContent || '').trim();
        }
        const markdowns = document.querySelectorAll('.markdown');
        if (markdowns.length > 0) {
          return (markdowns[markdowns.length - 1].innerText || '').trim();
        }
        return '';
      }
    },

    ChatGPT: {
      getModelName() {
        const modelBtn =
          document.querySelector('button[data-testid="model-switcher-dropdown-button"]') ||
          document.querySelector('button[aria-haspopup="menu"] span') ||
          document.querySelector('div[data-testid="model-switcher"]');
        if (modelBtn) {
          const text = (modelBtn.innerText || modelBtn.textContent || '').trim();
          if (text) return text.split('\n')[0].trim();
        }
        return 'ChatGPT';
      },
      findInputBox() {
        return (
          document.querySelector('#prompt-textarea') ||
          document.querySelector('textarea[data-id="root"]') ||
          document.querySelector('div#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('textarea')
        );
      },
      findSendButton() {
        return (
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
          document.querySelector('button[aria-label*="Send prompt"]') ||
          document.querySelector('button[aria-label*="Send"]')
        );
      },
      findStopButton() {
        return (
          document.querySelector('button[data-testid="stop-button"]') ||
          document.querySelector('button[aria-label*="Stop generating"]') ||
          document.querySelector('button[aria-label*="Stop"]')
        );
      },
      getLatestResponseText() {
        const assistants = document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn');
        if (assistants.length > 0) {
          const last = assistants[assistants.length - 1];
          const markdown = last.querySelector('.markdown') || last;
          return (markdown.innerText || markdown.textContent || '').trim();
        }
        return '';
      }
    },

    Claude: {
      getModelName() {
        const selector =
          document.querySelector('button[aria-haspopup="menu"] [data-testid*="model"]') ||
          document.querySelector('button[data-testid="model-selector-dropdown"]') ||
          document.querySelector('button[aria-haspopup="menu"]');
        if (selector) {
          const text = (selector.innerText || selector.textContent || '').trim();
          if (text && (text.includes('Claude') || text.includes('Sonnet') || text.includes('Opus') || text.includes('Haiku'))) {
            return text.split('\n')[0].trim();
          }
        }
        return 'Claude 3.7 Sonnet';
      },
      findInputBox() {
        return (
          document.querySelector('div[contenteditable="true"].ProseMirror') ||
          document.querySelector('fieldset div[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"]')
        );
      },
      findSendButton() {
        return (
          document.querySelector('button[aria-label*="Send Message"]') ||
          document.querySelector('button[aria-label*="Send"]') ||
          document.querySelector('button[data-testid="send-button"]')
        );
      },
      findStopButton() {
        return (
          document.querySelector('button[aria-label*="Stop responding"]') ||
          document.querySelector('button[aria-label*="Stop Response"]') ||
          document.querySelector('button[aria-label*="Stop"]')
        );
      },
      getLatestResponseText() {
        const messages = document.querySelectorAll(
          '.font-claude-message, [data-testid="chat-message-assistant"], .prose'
        );
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          return (last.innerText || last.textContent || '').trim();
        }
        return '';
      }
    }
  };

  const currentAdapter = Adapters[platform] || Adapters.Gemini;

  // 3. Floating Status Badge
  const badge = document.createElement('div');
  badge.id = 'gemini-agent-bridge-badge';
  badge.style.position = 'fixed';
  badge.style.bottom = '16px';
  badge.style.left = '16px';
  badge.style.zIndex = '999999';
  badge.style.display = 'flex';
  badge.style.alignItems = 'center';
  badge.style.gap = '8px';
  badge.style.padding = '8px 14px';
  badge.style.backgroundColor = '#0f172a';
  badge.style.color = '#f8fafc';
  badge.style.fontFamily = 'system-ui, -apple-system, sans-serif';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '600';
  badge.style.borderRadius = '9999px';
  badge.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.35)';
  badge.style.border = '1px solid rgba(255, 255, 255, 0.15)';
  badge.style.userSelect = 'none';
  badge.style.transition = 'all 0.2s ease-in-out';

  const dot = document.createElement('span');
  dot.style.width = '8px';
  dot.style.height = '8px';
  dot.style.borderRadius = '50%';
  dot.style.backgroundColor = '#ef4444';
  dot.style.display = 'inline-block';

  const textLabel = document.createElement('span');
  textLabel.textContent = 'Agent Bridge: Disconnected';

  badge.appendChild(dot);
  badge.appendChild(textLabel);
  document.body.appendChild(badge);

  function setStatus(status) {
    const activeModel = currentAdapter.getModelName();
    const modeLabel = safeModeActive ? 'Safe Mode' : 'Fast Mode';
    if (status === 'connected' || status === 'ready') {
      dot.style.backgroundColor = '#10b981';
      textLabel.textContent = `Agent Bridge: Ready [${platform}: ${activeModel} | ${modeLabel}]`;
    } else if (status === 'busy') {
      dot.style.backgroundColor = '#f59e0b';
      textLabel.textContent = `Agent Bridge: Busy [${platform}: ${activeModel} | ${modeLabel}]`;
    } else {
      dot.style.backgroundColor = '#ef4444';
      textLabel.textContent = 'Agent Bridge: Disconnected';
    }
  }

  // 4. Human-like Simulated Pointer Events
  function simulateHumanClick(element) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    const offsetX = rect.width * (0.35 + Math.random() * 0.3);
    const offsetY = rect.height * (0.35 + Math.random() * 0.3);
    const clientX = Math.round(rect.left + offsetX);
    const clientY = Math.round(rect.top + offsetY);
    const screenX = Math.round(window.screenX + clientX);
    const screenY = Math.round(window.screenY + clientY);

    const baseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX,
      clientY,
      screenX,
      screenY,
      button: 0
    };

    const downInit = {
      ...baseEventInit,
      buttons: 1
    };

    const upInit = {
      ...baseEventInit,
      buttons: 0
    };

    const pointerDownInit = {
      ...downInit,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0.5
    };

    const pointerUpInit = {
      ...upInit,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0
    };

    if (typeof PointerEvent === 'function') {
      element.dispatchEvent(new PointerEvent('pointerdown', pointerDownInit));
    }
    element.dispatchEvent(new MouseEvent('mousedown', downInit));

    if (typeof PointerEvent === 'function') {
      element.dispatchEvent(new PointerEvent('pointerup', pointerUpInit));
    }
    element.dispatchEvent(new MouseEvent('mouseup', upInit));
    element.dispatchEvent(new MouseEvent('click', upInit));

    return true;
  }

  // 5. Universal Binary & Media File Attachment Engine
  function parseIncomingFile(item, index) {
    let name = `upload_${Date.now()}_${index}`;
    let type = 'application/octet-stream';
    let base64 = '';

    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('data:')) {
        const match = trimmed.match(/^data:([^;]+);base64,(.*)$/s);
        if (match) {
          type = match[1];
          base64 = match[2];
        } else {
          const comma = trimmed.indexOf(',');
          if (comma !== -1) {
            const m = trimmed.slice(0, comma).match(/:(.*?);/);
            if (m) type = m[1];
            base64 = trimmed.slice(comma + 1);
          }
        }
      } else {
        base64 = trimmed;
      }
    } else if (item && typeof item === 'object') {
      name = item.name || item.filename || name;
      type = item.type || item.mime || item.mimeType || type;
      base64 = item.data || item.base64 || item.content || '';
      if (typeof base64 === 'string' && base64.startsWith('data:')) {
        const m = base64.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) {
          if (!item.type && !item.mime) type = m[1];
          base64 = m[2];
        }
      }
    }

    if (!base64 || typeof base64 !== 'string') return null;

    if (!name.includes('.')) {
      const extMap = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/svg+xml': 'svg',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'application/json': 'json',
        'application/zip': 'zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'video/mp4': 'mp4'
      };
      const ext = extMap[type] || 'bin';
      name = `${name}.${ext}`;
    }

    try {
      const cleanBase64 = base64.replace(/[\r\n\s]/g, '');
      const binaryStr = atob(cleanBase64);
      const len = binaryStr.length;
      const u8arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        u8arr[i] = binaryStr.charCodeAt(i);
      }
      return new File([u8arr], name, { type, lastModified: Date.now() });
    } catch (e) {
      console.error('[Agent Bridge] Failed to decode base64 file:', e);
      return null;
    }
  }

  function hasAttachmentInDOM() {
    return !!(
      document.querySelector('uploader-file-preview') ||
      document.querySelector('gem-attachment') ||
      document.querySelector('gem-media-attachment') ||
      document.querySelector('.attachment-preview-wrapper') ||
      document.querySelector('.file-preview-chip') ||
      document.querySelector('bard-attachment-card') ||
      document.querySelector('[data-test-id*="attachment"]') ||
      document.querySelector('[data-testid*="attachment"]') ||
      document.querySelector('.attachment-card') ||
      document.querySelector('.file-preview') ||
      document.querySelector('[data-test-id*="file"]') ||
      document.querySelector('mat-chip') ||
      document.querySelector('button[aria-label*="Remove" i]') ||
      document.querySelector('button[aria-label*="ลบ" i]') ||
      document.querySelector('img[src*="blob:"]')
    );
  }

  function isUploadInProgress() {
    return !!(
      document.querySelector('.gem-attachment-loading-container') ||
      document.querySelector('.gem-attachment-content.loading') ||
      document.querySelector('mat-progress-bar') ||
      document.querySelector('[role="progressbar"]') ||
      document.querySelector('.upload-progress') ||
      document.querySelector('svg.spinner') ||
      document.querySelector('[data-testid*="uploading"]')
    );
  }

  function findAttachButton() {
    return (
      document.querySelector('button:has(mat-icon[fonticon="plus"])') ||
      document.querySelector('button:has(mat-icon[data-mat-icon-name="plus"])') ||
      document.querySelector('gem-icon-button.gem-menu-button button') ||
      document.querySelector('gem-icon-button.menu-button button') ||
      document.querySelector('button[aria-label*="เครื่องมือ" i]') ||
      document.querySelector('button[aria-label*="Upload" i]') ||
      document.querySelector('button[aria-label*="tools" i]') ||
      document.querySelector('button[aria-label*="Attach" i]') ||
      document.querySelector('button[aria-label*="Add" i]') ||
      document.querySelector('button[aria-label*="แนบ" i]') ||
      document.querySelector('button[aria-label*="อัปโหลด" i]') ||
      document.querySelector('button[aria-label*="เพิ่ม" i]') ||
      document.querySelector('button[data-testid*="attach"]') ||
      document.querySelector('button[data-test-id*="uploader"]') ||
      document.querySelector('button:has(mat-icon[fonticon="add"])') ||
      document.querySelector('button:has(mat-icon[fonticon="attach_file"])') ||
      document.querySelector('button:has(mat-icon[fonticon="upload"])') ||
      document.querySelector('button.file-uploader') ||
      document.querySelector('bard-file-uploader button')
    );
  }

  function pickBestFileInput(fileInputs, file) {
    if (!fileInputs || fileInputs.length === 0) return null;
    const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/');
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (isMedia) {
      const mediaInput = fileInputs.find((i) => i.accept && (i.accept.includes('image') || i.accept.includes('video') || i.accept.includes('audio')));
      if (mediaInput) return mediaInput;
    } else {
      const extInput = fileInputs.find((i) => i.accept && i.accept.toLowerCase().includes(ext));
      if (extInput) return extInput;

      const docInput = fileInputs.find(
        (i) => i.accept && !i.accept.startsWith('image/') && (i.accept.includes('.pdf') || i.accept.includes('.txt') || i.accept.includes('*/*') || i.accept.includes('.doc') || i.accept.includes('.zip'))
      );
      if (docInput) return docInput;
    }

    const genericInput = fileInputs.find((i) => !i.accept || i.accept === '*' || i.accept === '*/*');
    if (genericInput) return genericInput;

    return fileInputs[0];
  }

  function dispatchFileInput(inputElement, file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    if (inputElement._valueTracker) {
      try {
        inputElement._valueTracker.setValue('');
      } catch {}
    }

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
    if (desc && desc.set) {
      try {
        desc.set.call(inputElement, dt.files);
      } catch {}
    }
    try {
      inputElement.files = dt.files;
    } catch {}

    inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
  }

  function dispatchDragAndDrop(file) {
    const targets = [
      currentAdapter.findInputBox(),
      document.querySelector('rich-textarea'),
      document.querySelector('bard-file-drop-target'),
      document.querySelector('#prompt-textarea'),
      document.querySelector('div[contenteditable="true"].ProseMirror'),
      document.querySelector('form'),
      document.querySelector('main'),
      document.body
    ].filter(Boolean);

    const dt = new DataTransfer();
    dt.items.add(file);

    for (const target of targets) {
      try {
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        if (hasAttachmentInDOM()) break;
      } catch {}
    }
  }

  function dispatchClipboardPaste(file) {
    const input = currentAdapter.findInputBox();
    if (!input) return;
    try {
      input.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      });
      input.dispatchEvent(pasteEvent);
    } catch {}
  }

  async function closeUploadMenuIfOpen() {
    const menu = document.querySelector('.mat-mdc-menu-panel, [role="menu"], .cdk-overlay-pane');
    if (menu) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) {
        try { backdrop.click(); } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function attachFiles(filesList) {
    if (!Array.isArray(filesList) || filesList.length === 0) return true;

    for (let i = 0; i < filesList.length; i++) {
      const item = filesList[i];
      if (!item) continue;
      const file = parseIncomingFile(item, i + 1);
      if (!file) continue;

      try {
        if (socket && socket.readyState === 1) {
          socket.send(
            JSON.stringify({
              type: 'STATUS',
              log: `Attaching file ${i + 1}/${filesList.length}: ${file.name} (${file.type}, ${file.size} bytes)...`
            })
          );
        }

        // Method 1: Find or open native File Input
        let fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));

        if (fileInputs.length === 0) {
          const menuOpen = document.querySelector('.mat-mdc-menu-panel, [role="menu"]');
          if (!menuOpen) {
            const attachBtn = findAttachButton();
            if (attachBtn) {
              attachBtn.click();
              await new Promise((r) => setTimeout(r, 500));
              fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
            }
          } else {
            fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
          }
        }

        let assigned = false;
        if (fileInputs.length > 0) {
          const targetInput = pickBestFileInput(fileInputs, file);
          if (targetInput) {
            dispatchFileInput(targetInput, file);
            assigned = true;
          }
        }

        // Close menu if opened so input and buttons remain accessible
        await closeUploadMenuIfOpen();

        // Verification pause
        await new Promise((r) => setTimeout(r, 800));

        // Method 2: Drag & drop fallback if not visible in DOM
        if (!hasAttachmentInDOM()) {
          dispatchDragAndDrop(file);
          await new Promise((r) => setTimeout(r, 600));
        }

        // Method 3: Clipboard paste fallback for images
        if (!hasAttachmentInDOM() && file.type.startsWith('image/')) {
          dispatchClipboardPaste(file);
          await new Promise((r) => setTimeout(r, 600));
        }

        // Method 4: Wait for upload progress to settle
        const uploadStart = Date.now();
        while (Date.now() - uploadStart < 25000) {
          if (hasAttachmentInDOM() && !isUploadInProgress()) {
            await new Promise((r) => setTimeout(r, 500));
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }

        if (socket && socket.readyState === 1) {
          socket.send(
            JSON.stringify({
              type: 'STATUS',
              log: `File ready: ${file.name} (${file.type}, ${file.size} bytes)`
            })
          );
        }
      } catch (err) {
        console.error('[Agent Bridge] File attachment error:', err);
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'STATUS', log: `Failed to attach ${file.name}: ${err.message}` }));
        }
      }
    }

    // Safety settle delay for input box
    await new Promise((resolve) => setTimeout(resolve, 800));
    return true;
  }

  function injectPrompt(text) {
    const input = currentAdapter.findInputBox();
    if (!input) {
      console.error(`[Agent Bridge] Input element not found on ${platform}`);
      return false;
    }

    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    if (input.tagName.toLowerCase() === 'textarea') {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    // Rich contenteditable / ProseMirror elements (Gemini / Claude / ChatGPT)
    let p = input.querySelector('p');
    if (!p) {
      p = document.createElement('p');
      input.appendChild(p);
    }
    p.textContent = text;

    // Trigger Angular / Quill input listeners
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true }));
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    try {
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    } catch {}

    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  function submitPrompt() {
    const sendBtn = currentAdapter.findSendButton();
    if (sendBtn) {
      if (sendBtn.getAttribute('aria-disabled') === 'true') {
        sendBtn.setAttribute('aria-disabled', 'false');
      }
      sendBtn.disabled = false;
      simulateHumanClick(sendBtn);
      try {
        sendBtn.click();
      } catch {}
      return true;
    }

    const input = currentAdapter.findInputBox();
    if (input) {
      input.focus();
      const enterDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      input.dispatchEvent(enterDown);
      return true;
    }

    return false;
  }

  // 6. Response Monitor
  function monitorResponse(initialText) {
    return new Promise((resolve) => {
      let settledTimer = null;
      let hasStarted = false;
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        const stopBtn = currentAdapter.findStopButton();
        const currentText = currentAdapter.getLatestResponseText();

        if (stopBtn) {
          hasStarted = true;
          setStatus('busy');
        }

        if (!hasStarted && currentText !== initialText && currentText.length > 0) {
          hasStarted = true;
          setStatus('busy');
        }

        if (hasStarted && !stopBtn) {
          if (!settledTimer) {
            settledTimer = setTimeout(() => {
              clearInterval(checkInterval);
              const finalText = currentAdapter.getLatestResponseText();
              resolve(finalText);
            }, 1200);
          }
        } else if (stopBtn && settledTimer) {
          clearTimeout(settledTimer);
          settledTimer = null;
        }

        // Safety timeout: 3 minutes max
        if (Date.now() - startTime > 180000) {
          clearInterval(checkInterval);
          if (settledTimer) clearTimeout(settledTimer);
          resolve(currentAdapter.getLatestResponseText());
        }
      }, 400);
    });
  }

  // 7. WebSocket Lifecycle
  function connect() {
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      setStatus('disconnected');
      setTimeout(connect, reconnectInterval);
      return;
    }

    socket.onopen = () => {
      const activeModel = currentAdapter.getModelName();
      lastReportedModel = activeModel;
      console.log(`[Agent Bridge] Connected to CLI orchestrator on ${platform} (${activeModel}) [Safe Mode: ${safeModeActive}]`);
      setStatus('ready');

      socket.send(
        JSON.stringify({
          type: 'HELLO',
          version: '2.0.0-attach-files',
          platform,
          model: activeModel,
          safeMode: safeModeActive,
          url: window.location.href
        })
      );
    };

    socket.onclose = () => {
      console.log('[Agent Bridge] Disconnected from CLI orchestrator, retrying...');
      setStatus('disconnected');
      socket = null;
      setTimeout(connect, reconnectInterval);
    };

    socket.onerror = () => {
      setStatus('disconnected');
    };

    socket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'CONFIG') {
          if (msg.safeMode !== undefined) {
            safeModeActive = Boolean(msg.safeMode);
          }
          setStatus(isGenerating ? 'busy' : 'ready');
          return;
        }

        if (msg.type === 'PROMPT') {
          if (msg.safeMode !== undefined) {
            safeModeActive = Boolean(msg.safeMode);
          }

          if (isGenerating) {
            socket.send(
              JSON.stringify({
                type: 'ERROR',
                message: `${platform} is currently busy processing another turn.`
              })
            );
            return;
          }

          isGenerating = true;
          setStatus('busy');

          // 1. Attach any binary files, documents, or media first
          const filesToAttach = msg.files || msg.images;
          if (Array.isArray(filesToAttach) && filesToAttach.length > 0) {
            await attachFiles(filesToAttach);
          }

          const baselineText = currentAdapter.getLatestResponseText();
          const promptText =
            msg.text && msg.text.trim()
              ? msg.text
              : Array.isArray(filesToAttach) && filesToAttach.length > 0
              ? 'Please inspect and analyze the attached file.'
              : '';
          const injected = injectPrompt(promptText);

          if (!injected) {
            isGenerating = false;
            setStatus('ready');
            socket.send(
              JSON.stringify({
                type: 'ERROR',
                message: `Failed to inject prompt into ${platform} input element.`
              })
            );
            return;
          }

          // Humanized jitter delay: between 1200ms and 2400ms in safe mode (never 0ms)
          const delayMs = safeModeActive
            ? Math.floor(1200 + Math.random() * 1200)
            : 300;

          setTimeout(async () => {
            submitPrompt();
            const resultText = await monitorResponse(baselineText);
            isGenerating = false;
            setStatus('ready');

            socket.send(
              JSON.stringify({
                type: 'RESPONSE',
                text: resultText
              })
            );
          }, delayMs);
        }
      } catch (err) {
        console.error('[Agent Bridge] Message processing error:', err);
      }
    };
  }

  // Periodic model check to notify CLI if model changes dynamically
  setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const currentModel = currentAdapter.getModelName();
      if (currentModel !== lastReportedModel) {
        lastReportedModel = currentModel;
        setStatus('ready');
        socket.send(
          JSON.stringify({
            type: 'STATUS',
            platform,
            model: currentModel,
            safeMode: safeModeActive
          })
        );
      }
    }
  }, 3000);

  connect();
})();
