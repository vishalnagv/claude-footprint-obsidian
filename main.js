const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, ItemView } = require('obsidian');

const VIEW_TYPE_CHAT = 'claude-footprint-chat-view';

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-4-6',
  footprintFolder: '',
  chatFileName: 'claude.md',
  maxDaysContext: 14,
  maxCharsPerNote: 12000
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

module.exports = class ClaudeFootprintPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ClaudeFootprintSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ClaudeFootprintChatView(leaf, this));

    this.addCommand({
      id: 'open-claude-footprint-chat',
      name: 'Open Claude Footprint chat',
      callback: () => this.activateChatView()
    });

    this.addCommand({
      id: 'ask-claude-footprint',
      name: 'Ask Claude about my Footprint notes (via claude.md)',
      callback: () => this.handleAskInNote()
    });

    this.addCommand({
      id: 'import-claude-export',
      name: 'Import Claude export (conversations.json)',
      callback: () => this.handleImport()
    });

    this.addRibbonIcon('message-circle', 'Open Claude Footprint chat', () => this.activateChatView());
    this.addRibbonIcon('import', 'Import Claude export', () => this.handleImport());
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  async activateChatView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    const data = (await this.loadData()) || {};
    Object.assign(data, this.settings);
    await this.saveData(data);
  }

  // ---------- Shared core: used by both the sidebar chat and the claude.md command ----------

  async answerQuestion(question) {
    if (!this.settings.apiKey) {
      throw new Error('Set your Anthropic API key in Claude Footprint settings first.');
    }

    const dates = parseDatesFromText(question);
    const { context, matchedFiles } = await this.gatherContext(dates);

    if (matchedFiles.length === 0) {
      return {
        answer: `I couldn't find any daily notes matching that in "${this.settings.footprintFolder || '(vault root)'}". Check the folder setting and that your daily notes are named with a date (e.g. 2026-06-30.md).`,
        sources: []
      };
    }

    const answer = await this.callClaude(question, context);
    return { answer, sources: matchedFiles.map(f => f.name) };
  }

  async gatherContext(dates) {
    const folderPath = this.settings.footprintFolder.replace(/^\/+|\/+$/g, '');
    let files = this.app.vault.getFiles().filter(f => {
      if (f.extension !== 'md') return false;
      if (f.path === this.settings.chatFileName) return false;
      if (folderPath && !(f.path === folderPath || f.path.startsWith(folderPath + '/'))) return false;
      return /\d{4}-\d{2}-\d{2}/.test(f.name);
    });

    let matched;
    if (dates.length > 0) {
      matched = files.filter(f => dates.some(d => f.name.includes(d)));
    } else {
      matched = files
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, this.settings.maxDaysContext);
    }

    matched.sort((a, b) => a.name.localeCompare(b.name));

    let context = '';
    for (const f of matched) {
      let text = await this.app.vault.read(f);
      if (text.length > this.settings.maxCharsPerNote) {
        text = text.slice(0, this.settings.maxCharsPerNote) + '\n\n[...truncated...]';
      }
      context += `\n\n## Notes from ${f.name}\n${text}`;
    }

    return { context, matchedFiles: matched };
  }

  async callClaude(question, context) {
    const systemPrompt = 'You are analyzing the user\'s personal archive of their own Claude.ai chat history, ' +
      'exported as daily markdown notes. Use only the provided notes as context; do not invent details. ' +
      'Give a well-organized, detailed answer to the user\'s question, grouped by topic or by day as appropriate. ' +
      'If the notes provided do not actually contain anything relevant to the question, say so plainly instead of guessing.';

    const userMessage = `Question: ${question}\n\nRelevant daily notes:\n${context}`;

    const response = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      }),
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const msg = response.json && response.json.error ? response.json.error.message : `HTTP ${response.status}`;
      throw new Error(msg);
    }

    return response.json.content.map(c => c.text || '').join('\n').trim();
  }

  // ---------- claude.md flow (kept for anyone who prefers writing in a note) ----------

  async handleAskInNote() {
    const file = this.app.vault.getAbstractFileByPath(this.settings.chatFileName);
    if (!file) {
      new Notice(`Could not find "${this.settings.chatFileName}" in your vault. Create it first.`);
      return;
    }

    const content = await this.app.vault.read(file);
    const question = extractLastQuestion(content);
    if (!question) {
      new Notice('No question found. Write a question as the last line of the file, e.g. starting with ">> ".');
      return;
    }

    new Notice('Asking Claude...');
    try {
      const { answer, sources } = await this.answerQuestion(question);
      const sourcesLine = sources.length ? `\n\n*Sources: ${sources.join(', ')}*` : '';
      const updated = content.trimEnd() + `\n\n**Claude:** ${answer}${sourcesLine}\n\n---\n`;
      await this.app.vault.modify(file, updated);
      new Notice('Answer added to ' + this.settings.chatFileName);
    } catch (e) {
      new Notice('Error: ' + e.message);
      console.error('Claude Footprint error:', e);
    }
  }

  // ---------- Import flow ----------

  handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;

      new Notice('Reading export file...');
      try {
        const text = await file.text();
        await this.importConversations(text);
      } catch (e) {
        new Notice('Import failed: ' + e.message);
        console.error('Claude Footprint import error:', e);
      }
    };

    input.click();
  }

  async importConversations(jsonText) {
    let raw;
    try {
      raw = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('That file is not valid JSON. Make sure you selected conversations.json from your Claude export.');
    }

    const conversations = Array.isArray(raw) ? raw : (raw.conversations || []);
    if (conversations.length === 0) {
      throw new Error('No conversations found in this file. Make sure you selected conversations.json.');
    }

    const importedIndex = await this.loadImportIndex();
    const folderPath = this.settings.footprintFolder.replace(/^\/+|\/+$/g, '');

    if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    let filed = 0;
    let skipped = 0;
    const dayBuffers = {};

    for (const convo of conversations) {
      const uuid = convo.uuid || convo.id;
      if (!uuid) continue;

      if (importedIndex[uuid]) {
        skipped++;
        continue;
      }

      const createdAt = convo.created_at || convo.updated_at;
      if (!createdAt) continue;

      const date = new Date(createdAt).toISOString().slice(0, 10);
      const title = convo.name || '(untitled conversation)';
      const messages = convo.chat_messages || convo.messages || [];

      let block = `\n\n## ${title}\n*Started: ${formatTimestamp(createdAt)}*\n`;
      for (const msg of messages) {
        const sender = msg.sender === 'human' ? 'Human' : 'Claude';
        const msgText = extractMessageText(msg);
        if (!msgText) continue;
        block += `\n**${sender}** (${formatTimestamp(msg.created_at)}):\n\n${msgText}\n`;
      }

      dayBuffers[date] = (dayBuffers[date] || '') + block;
      importedIndex[uuid] = { date, title, filedAt: new Date().toISOString() };
      filed++;
    }

    for (const [date, block] of Object.entries(dayBuffers)) {
      const filePath = folderPath ? `${folderPath}/${date}.md` : `${date}.md`;
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing) {
        const current = await this.app.vault.read(existing);
        await this.app.vault.modify(existing, current + block);
      } else {
        await this.app.vault.create(filePath, block.trimStart());
      }
    }

    await this.saveImportIndex(importedIndex);
    new Notice(`Import complete: filed ${filed} new conversation(s), skipped ${skipped} already-imported.`);
  }

  async loadImportIndex() {
    const data = await this.loadData();
    return (data && data.importIndex) || {};
  }

  async saveImportIndex(index) {
    const data = (await this.loadData()) || {};
    data.importIndex = index;
    await this.saveData(data);
  }
};

// ---------- Sidebar chat view ----------

class ClaudeFootprintChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.history = [];
  }

  getViewType() { return VIEW_TYPE_CHAT; }
  getDisplayText() { return 'Claude Footprint'; }
  getIcon() { return 'message-circle'; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('claude-footprint-chat-container');

    this.messagesEl = container.createDiv({ cls: 'cf-messages' });

    const inputRow = container.createDiv({ cls: 'cf-input-row' });
    this.textarea = inputRow.createEl('textarea', {
      cls: 'cf-textarea',
      attr: { placeholder: 'Ask about your Claude Footprint notes... (Enter to send, Shift+Enter for newline)' }
    });
    this.sendButton = inputRow.createEl('button', { text: 'Send', cls: 'cf-send-btn' });

    this.sendButton.onclick = () => this.send();
    this.textarea.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        this.send();
      }
    });

    this.renderMessages();
  }

  async onClose() {}

  renderMessages() {
    this.messagesEl.empty();
    for (const msg of this.history) {
      const bubble = this.messagesEl.createDiv({ cls: `cf-bubble cf-${msg.role}` });
      bubble.createDiv({ cls: 'cf-bubble-text', text: msg.text });
      if (msg.sources && msg.sources.length) {
        bubble.createDiv({ cls: 'cf-sources', text: `Sources: ${msg.sources.join(', ')}` });
      }
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async send() {
    const question = this.textarea.value.trim();
    if (!question) return;

    this.textarea.value = '';
    this.history.push({ role: 'user', text: question });
    this.history.push({ role: 'assistant', text: 'Thinking...', pending: true });
    this.renderMessages();

    try {
      const { answer, sources } = await this.plugin.answerQuestion(question);
      this.history[this.history.length - 1] = { role: 'assistant', text: answer, sources };
    } catch (e) {
      this.history[this.history.length - 1] = { role: 'assistant', text: 'Error: ' + e.message };
      console.error('Claude Footprint error:', e);
    }

    this.renderMessages();
  }
}

// ---------- Shared helpers ----------

function extractLastQuestion(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('**Claude:**')) continue;
    if (lines[i].startsWith('*Sources:')) continue;
    if (lines[i] === '---') continue;
    return lines[i].replace(/^>>\s*/, '').replace(/^Q:\s*/i, '');
  }
  return null;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function extractMessageText(message) {
  if (typeof message.text === 'string' && message.text.length > 0) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block.type === 'text' && block.text) return block.text;
        if (block.type === 'tool_use') return `[used tool: ${block.name || 'unknown'}]`;
        if (block.type === 'tool_result') return '[tool result omitted]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseDatesFromText(text) {
  const results = [];
  const year = new Date().getFullYear();

  const isoMatches = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoMatches) results.push(...isoMatches);

  const dayMonthRegex = /(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)/gi;
  let m;
  while ((m = dayMonthRegex.exec(text)) !== null) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[3].toLowerCase()];
    results.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }

  const monthDayRegex = /(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(st|nd|rd|th)?/gi;
  while ((m = monthDayRegex.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    results.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }

  const today = new Date();
  if (/\btoday\b/i.test(text)) results.push(fmt(today));
  if (/\byesterday\b/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    results.push(fmt(d));
  }
  if (/\bthis week\b/i.test(text)) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      results.push(fmt(d));
    }
  }
  if (/\blast week\b/i.test(text)) {
    for (let i = 7; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      results.push(fmt(d));
    }
  }

  return [...new Set(results)];
}

class ClaudeFootprintSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Claude Footprint settings' });

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc('From console.anthropic.com. Used only to answer questions you ask, billed per use.')
      .addText(text => text
        .setPlaceholder('sk-ant-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Anthropic model string to use for analysis.')
      .addText(text => text
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Footprint folder')
      .setDesc('Vault-relative folder containing your daily export notes (named like 2026-06-30.md). Leave blank to use the vault root.')
      .addText(text => text
        .setPlaceholder('Footprint')
        .setValue(this.plugin.settings.footprintFolder)
        .onChange(async (value) => {
          this.plugin.settings.footprintFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chat file name')
      .setDesc('Used only by the "Ask via claude.md" command, not the sidebar chat panel.')
      .addText(text => text
        .setValue(this.plugin.settings.chatFileName)
        .onChange(async (value) => {
          this.plugin.settings.chatFileName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default lookback (days)')
      .setDesc('When your question has no date in it, how many recent daily notes to consider.')
      .addText(text => text
        .setValue(String(this.plugin.settings.maxDaysContext))
        .onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxDaysContext = n;
            await this.plugin.saveSettings();
          }
        }));
  }
}
