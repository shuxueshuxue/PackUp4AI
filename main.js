const { Plugin, PluginSettingTab, Notice, Modal, Setting, TFile } = require('obsidian');

// --- Constants ---
const D3_CDN_URL = 'https://d3js.org/d3.v7.min.js'; // Use CDN
const PLUGIN_NAME = 'packup4AI';
const MODAL_TITLE = 'packup4AI Notes Explorer';

class Packup4AIPlugin extends Plugin {
  settings = {
    maxDepth: 3,
    excludePaths: ["packup4ai-output.md"], // Default excluded file matches output
    outputFile: "packup4ai-output.md",
    includeBacklinks: true,
  };

  async onload() {
    console.log(`Loading ${PLUGIN_NAME}`);

    // Load settings
    this.settings = Object.assign({}, this.settings, await this.loadData());

    // Add styles
    this.addStyles();

    // Register command
    this.addCommand({
      id: 'open-packup4ai-notes',
      name: 'Open packup4AI Notes',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Please open a note first before using packup4AI.");
          return;
        }
        new PackupModal(this.app, this).open();
      }
    });

    // Add settings tab
    this.addSettingTab(new Packup4AISettingTab(this.app, this));

    // Add status bar shortcut
    const statusBar = this.addStatusBarItem();
    statusBar.setText(PLUGIN_NAME);
    statusBar.onClickEvent(() => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice("Please open a note first before using packup4AI.");
        return;
      }
      new PackupModal(this.app, this).open();
    });
  }

  addStyles() {
    const css = `
      .packup4ai-modal {
        min-width: 700px;
        width: 85vw;
        max-width: 1000px;
      }
      .packup4ai-content {
        min-height: 450px;
      }
      .packup4ai-dual-pane {
        display: flex;
        gap: 15px;
      }
      .packup4ai-left-pane, .packup4ai-right-pane {
        flex: 1;
        min-width: 250px;
        display: flex;
        flex-direction: column;
      }
      .packup4ai-right-pane {
        border-left: 1px solid var(--background-modifier-border);
        padding-left: 15px;
      }
      .packup4ai-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        border-top: 1px solid var(--background-modifier-border);
        padding-top: 5px;
        margin-top: 5px;
      }
      .depth-display {
        display: inline-block;
        padding: 4px 8px;
        margin-right: 8px;
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border-radius: 4px;
        font-weight: bold;
      }
      .collection-status {
        margin-top: 10px;
        padding: 6px 10px;
        background: var(--background-primary-alt);
        border-radius: 4px;
      }
      .word-count-stats {
        margin-top: 10px;
        padding: 6px 10px;
        background: var(--background-secondary-alt);
        border-radius: 4px;
        font-size: 0.9em;
      }
      .packup4ai-viz-container {
        width: 100%;
        height: 450px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        overflow: hidden;
      }
      .packup4ai-viz-container svg {
        background-color: var(--background-secondary);
        width: 100%;
        height: 100%;
      }
      .node-label {
        fill: var(--text-normal);
        font-size: 11px;
        pointer-events: none;
      }
    `;
    document.head.createEl('style', { text: css });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Core collection function
  async collectRelatedNotes(startFile, maxDepth) {
    console.log(`Starting collection from ${startFile.path} with depth ${maxDepth}`);

    const queue = [{ file: startFile, depth: 0 }];
    const visited = new Set([startFile.path]);
    const collected = [];

    try {
      // Add starting file
      const startContent = await this.app.vault.cachedRead(startFile);
      collected.push({
        file: startFile,
        depth: 0,
        content: startContent,
        parentPath: null
      });

      // BFS through related files
      while (queue.length) {
        const { file, depth } = queue.shift();

        // Stop if max depth reached
        if (depth >= maxDepth) continue;

        // Get links from this file
        const neighbors = await this.getRelatedFiles(file);

        // Process each neighbor
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor.path) && !this.shouldExclude(neighbor.path)) {
            visited.add(neighbor.path);

            try {
              const content = await this.app.vault.cachedRead(neighbor);
              collected.push({
                file: neighbor,
                depth: depth + 1,
                content,
                parentPath: file.path
              });
              queue.push({ file: neighbor, depth: depth + 1 });
            } catch (error) {
              console.warn(`Error reading file ${neighbor.path}:`, error);
              collected.push({
                file: neighbor,
                depth: depth + 1,
                content: `*Error reading file*`,
                parentPath: file.path
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Collection error:", error);
      throw new Error(`Collection failed: ${error.message}`);
    }

    console.log(`Collected ${collected.length} notes`);
    return collected;
  }

  // Get files related to the given file
  async getRelatedFiles(file) {
    const relatedFiles = new Set();

    // Forward links
    const cache = this.app.metadataCache.getFileCache(file) || {};
    (cache.links || []).forEach(link => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(link.link.split("#")[0], file.path);
      if (dest && dest.extension === "md") {
        relatedFiles.add(dest);
      }
    });

    // Backlinks (if enabled)
    if (this.settings.includeBacklinks) {
      const backlinks = this.app.metadataCache.getBacklinksForFile(file);
      if (backlinks && backlinks.data) {
        for (const backlinkPath in backlinks.data) {
          const file = this.app.vault.getAbstractFileByPath(backlinkPath);
          if (file && file.extension === "md") {
            relatedFiles.add(file);
          }
        }
      }
    }

    return Array.from(relatedFiles);
  }

  // Check if a path should be excluded
  shouldExclude(path) {
    const exclusions = this.settings.excludePaths || [];
    return exclusions.some(pattern => {
      if (!pattern) return false;
      pattern = pattern.trim();
      if (pattern === path) return true;
      if (pattern.endsWith('/') && path.startsWith(pattern)) return true;
      return false;
    });
  }

  // Simple word counter that works with different languages
  countWords(text) {
    if (!text) return 0;

    // Remove frontmatter
    const cleanText = text.replace(/^---\s*[\s\S]*?---\s*/, '').trim();

    // Detect if the text contains significant amount of CJK characters
    const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/g;
    const cjkMatches = cleanText.match(cjkRegex) || [];
    const cjkPercent = cleanText.length > 0 ? (cjkMatches.length / cleanText.length) : 0;

    if (cjkPercent > 0.15) {
      // For CJK languages, count characters (excluding spaces)
      return cleanText.replace(/\s+/g, '').length;
    } else {
      // For western languages, split by spaces and count
      return cleanText.split(/\s+/).filter(Boolean).length;
    }
  }

  // Calculate word statistics for the collected notes
  calculateWordStats(collected) {
    if (!collected || collected.length === 0) {
      return {
        totalWords: 0,
        avgWords: 0,
        minWords: 0,
        maxWords: 0
      };
    }

    // Count words for each note
    const wordCounts = collected.map(item => this.countWords(item.content));

    // Calculate statistics
    const totalWords = wordCounts.reduce((a, b) => a + b, 0);
    const avgWords = wordCounts.length > 0 ? Math.round(totalWords / wordCounts.length) : 0;
    const minWords = wordCounts.length > 0 ? Math.min(...wordCounts) : 0;
    const maxWords = wordCounts.length > 0 ? Math.max(...wordCounts) : 0;

    return {
      totalWords,
      avgWords,
      minWords,
      maxWords
    };
  }

  // Format collected notes for AI
  formatCollectedNotes(collected) {
    if (!collected || collected.length === 0) {
      return "No related files found.";
    }

    // Get starting file info
    const startItem = collected.find(i => i.depth === 0);
    const startName = startItem ? startItem.file.basename : "";
    const maxDepth = this.settings.maxDepth;

    let md = `# Context for AI\n\n`;
    md += `These are related files around "**${startName}**" up to **${maxDepth}** hops:\n\n`;
    md += `- Depth 0: The starting file itself.\n`;
    md += `- Depth 1: Files directly linked to/from the starting file.\n`;
    for (let d = 2; d <= maxDepth; d++) {
      md += `- Depth ${d}: Files ${d} hops away.\n`;
    }
    md += `\n---\n\n`;

    // Group by depth
    const byDepth = {};
    collected.forEach(i => {
      (byDepth[i.depth] = byDepth[i.depth] || []).push(i);
    });

    // Create sections for each depth
    for (let d = 0; d <= maxDepth; d++) {
      const group = byDepth[d];
      if (!group) continue;

      let sectionTitle;
      if (d === 0) sectionTitle = `Starting File: ${startName}`;
      else if (d === 1) sectionTitle = `Directly Linked Files`;
      else sectionTitle = `Files ${d} Hops Away`;

      md += `## ${sectionTitle} (Depth ${d})\n\n`;

      // Add each note in the group
      for (const item of group) {
        md += `### ${item.file.basename}  \n`;
        md += `Path: ${item.file.path}\n\n`;

        // Clean content (remove frontmatter)
        const clean = item.content
          .replace(/^---\s*[\s\S]*?---\s*/, '')
          .trim();

        // Wrap content in markdown code block with 4 backticks
        md += `\`\`\`\`markdown
${clean}
\`\`\`\`\n\n`;
      }
    }

    return md;
  }

  // Save to file
  async saveToFile(content, filename = this.settings.outputFile) {
    if (!filename.endsWith('.md')) filename += '.md';

    try {
      const existing = this.app.vault.getAbstractFileByPath(filename);

      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
        new Notice(`Updated file: ${filename}`);
      } else {
        await this.app.vault.create(filename, content);
        new Notice(`Created file: ${filename}`);
      }
      return true;
    } catch (error) {
      console.error(`Error writing file ${filename}:`, error);
      new Notice(`Error saving file: ${error.message}`);
      return false;
    }
  }

  // Load D3.js from CDN
  async loadD3() {
    // Return immediately if D3 is already loaded
    if (window.d3) return true;

    return new Promise((resolve, reject) => {
        console.log("Loading D3.js from CDN...");
        const script = document.createElement('script');
        script.src = D3_CDN_URL;
        script.async = true;

        script.onload = () => {
          console.log("D3.js loaded successfully from CDN");
          resolve(true);
        };

        script.onerror = (error) => {
          console.error("Failed to load D3.js from CDN:", error);
          reject(new Error("Failed to load D3.js visualization library"));
        };

        document.head.appendChild(script);
    });
  }
}

// --- Settings Tab ---
class Packup4AISettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: `${PLUGIN_NAME} Settings` });

    new Setting(containerEl)
      .setName("Max Collection Depth")
      .setDesc("How many links deep to collect notes from the starting point.")
      .addSlider(slider => slider
        .setLimits(1, 10, 1) // Increased to 10
        .setValue(this.plugin.settings.maxDepth)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxDepth = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Include Backlinks")
      .setDesc("Also collect notes that link to the notes being processed.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeBacklinks)
        .onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default Output Filename")
      .setDesc("Filename for the exported Markdown file.")
      .addText(text => text
        .setPlaceholder("e.g., packup4ai-output.md")
        .setValue(this.plugin.settings.outputFile)
        .onChange(async (value) => {
          this.plugin.settings.outputFile = value.endsWith('.md') ? value : `${value}.md`;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Excluded Files/Folders")
      .setDesc("Paths to exclude from collection (one per line). Folders must end with '/'.")
      .addTextArea(text => text
        .setPlaceholder("e.g., Templates/\nDrafts/ignore.md")
        .setValue((this.plugin.settings.excludePaths || []).join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludePaths = value
            .split("\n")
            .map(p => p.trim())
            .filter(p => p.length > 0);
          await this.plugin.saveSettings();
        }));
  }
}

// --- Main Modal ---
class PackupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.app = app;
    this.plugin = plugin;
    this.currentFile = this.app.workspace.getActiveFile();
    this.collectedData = null;
    this.isCollecting = false;
    this.simulation = null;
    this.lastCollectionPaths = new Set(); // Store previously collected paths
    this.wordStats = null; // Store word statistics
    this.modalEl.addClass('packup4ai-modal');
  }

  onOpen() {
    this.contentEl.empty();

    // Create layout
    this.contentEl.createEl('h2', { text: MODAL_TITLE });

    // Main content with dual panes
    const mainContent = this.contentEl.createDiv({ cls: 'packup4ai-content' });
    const dualPane = mainContent.createDiv({ cls: 'packup4ai-dual-pane' });

    // Left pane (settings)
    this.leftPane = dualPane.createDiv({ cls: 'packup4ai-left-pane' });

    // Right pane (visualization)
    this.rightPane = dualPane.createDiv({ cls: 'packup4ai-right-pane' });

    // Footer with buttons
    const footer = this.contentEl.createDiv({ cls: 'packup4ai-footer' });

    // Add button handlers
    this.createButtons(footer);

    // Render initial view
    this.renderUI();

    // Start initial collection
    this.collectNotes();
  }

  onClose() {
    // Clean up D3 simulation if running
    if (this.simulation) {
      this.simulation.stop();
    }
    this.collectedData = null;
    this.lastCollectionPaths = null;
    this.wordStats = null;
  }

  createButtons(footer) {
    // Copy to clipboard button
    const copyBtn = footer.createEl('button', {
      text: 'Collect & Copy to Clipboard',
      cls: 'mod-cta'
    });

    copyBtn.addEventListener('click', async () => {
      await this.ensureCollection();

      if (!this.collectedData || this.collectedData.length === 0) {
        new Notice('No notes to copy.');
        return;
      }

      const formatted = this.plugin.formatCollectedNotes(this.collectedData);
      await navigator.clipboard.writeText(formatted);
      new Notice(`Copied ${this.collectedData.length} notes to clipboard!`);
    });

    // Save to file button
    const saveBtn = footer.createEl('button', {
      text: 'Collect & Save to File'
    });

    saveBtn.addEventListener('click', async () => {
      await this.ensureCollection();

      if (!this.collectedData || this.collectedData.length === 0) {
        new Notice('No notes to save.');
        return;
      }

      const formatted = this.plugin.formatCollectedNotes(this.collectedData);
      await this.plugin.saveToFile(formatted); // Uses default filename from settings
    });
  }

  // Make sure we have collected data, collect if needed
  async ensureCollection() {
    if (this.isCollecting) {
      // Wait for ongoing collection to finish
      new Notice('Collection already in progress...');
      return;
    }

    if (!this.collectedData) {
      await this.collectNotes();
    }
  }

  // Check if collected notes changed compared to previous collection
  hasCollectionChanged(newData) {
    if (!newData) return true;

    // Create a set of paths from the new data
    const newPaths = new Set(newData.map(item => item.file.path));

    // If counts differ, collection changed
    if (!this.lastCollectionPaths || newPaths.size !== this.lastCollectionPaths.size) {
      return true;
    }

    // Check if all paths in new collection exist in the previous collection
    for (const path of newPaths) {
      if (!this.lastCollectionPaths.has(path)) {
        return true;
      }
    }

    // No change detected
    return false;
  }

  // Main collection function
  async collectNotes() {
    if (this.isCollecting) return;

    this.isCollecting = true;
    this.updateStatus('Collecting notes...');

    try {
      console.log(`Starting collection with depth ${this.plugin.settings.maxDepth}`);
      const data = await this.plugin.collectRelatedNotes(
        this.currentFile,
        this.plugin.settings.maxDepth
      );

      // Check if collection actually changed
      const hasChanged = this.hasCollectionChanged(data);

      // Store the new collection data
      this.collectedData = data;

      // Update the set of paths for future comparisons
      this.lastCollectionPaths = new Set(data.map(item => item.file.path));

      // Calculate word statistics
      this.wordStats = this.plugin.calculateWordStats(data);

      // Update status and word count display
      this.updateStatus(`Collected ${data.length} notes.`);
      this.updateWordStats();

      console.log(`Collection completed: ${data.length} notes`);

      // Only render visualization if the collection changed
      if (hasChanged) {
        console.log("Collection changed, updating visualization");
        this.renderVisualization();
      } else {
        console.log("Collection unchanged, skipping visualization refresh");
      }

    } catch (error) {
      console.error('Collection error:', error);
      this.updateStatus(`Error: ${error.message}`);
      new Notice(`Collection error: ${error.message}`);
    } finally {
      this.isCollecting = false;
    }
  }

  // Update just the status message
  updateStatus(message) {
    const statusEl = this.leftPane.querySelector('.collection-status');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // Update word statistics display
  updateWordStats() {
    let wordStatsEl = this.leftPane.querySelector('.word-count-stats');

    if (!wordStatsEl) {
      // Find the status element to insert after
      const statusEl = this.leftPane.querySelector('.collection-status');
      wordStatsEl = this.leftPane.createEl('div', {
        cls: 'word-count-stats'
      });
      if (statusEl) {
        statusEl.insertAdjacentElement('afterend', wordStatsEl);
      } else {
        // Fallback if status element isn't found (shouldn't happen)
        this.leftPane.appendChild(wordStatsEl);
      }
    }

    if (!this.wordStats) {
      wordStatsEl.textContent = 'No word statistics available.';
      return;
    }

    const { totalWords, avgWords, minWords, maxWords } = this.wordStats;

    wordStatsEl.empty();
    wordStatsEl.createEl('div', {
      text: `Total words: ${totalWords.toLocaleString()}`
    });
    wordStatsEl.createEl('div', {
      text: `Average words per note: ${avgWords.toLocaleString()}`
    });
    wordStatsEl.createEl('div', {
      text: `Range: ${minWords.toLocaleString()} - ${maxWords.toLocaleString()} words`
    });
  }

  // Render the UI (settings pane and visualization pane)
  renderUI() {
    this.renderSettingsPane();
    this.renderVisualizationPane();
  }

  // Render the settings (left) pane
  renderSettingsPane() {
    const pane = this.leftPane;
    pane.empty();

    // Title
    pane.createEl('h3', { text: 'Collection Settings' });

    // Starting note info
    pane.createEl('div', {
      text: `Starting Note: ${this.currentFile.basename}`
    });

    // Depth slider with visual indicator
    const depthSetting = new Setting(pane)
      .setName('Collection Depth');

    // Visual depth indicator
    const depthDisplay = createSpan({
      cls: 'depth-display',
      text: String(this.plugin.settings.maxDepth)
    });
    depthSetting.controlEl.prepend(depthDisplay);

    depthSetting.setDesc('How many links deep to collect notes.')
      .addSlider(slider => slider
        .setLimits(1, 10, 1) // Increased to 10
        .setValue(this.plugin.settings.maxDepth)
        .setDynamicTooltip()
        .onChange(async (value) => {
          // Update display immediately
          depthDisplay.textContent = String(value);

          // Save setting
          this.plugin.settings.maxDepth = value;
          await this.plugin.saveSettings();

          // Recollect notes with new depth
          this.collectNotes();
        })
      );

    // Include backlinks toggle
    new Setting(pane)
      .setName('Include Backlinks')
      .setDesc('Also collect notes that link to/from the starting note.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeBacklinks)
        .onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();

          // Recollect with new setting
          this.collectNotes();
        })
      );

    // Output filename
    new Setting(pane)
      .setName('Output Filename')
      .setDesc('Filename for saving the collected notes.')
      .addText(text => text
        .setValue(this.plugin.settings.outputFile)
        .onChange(async (value) => {
          this.plugin.settings.outputFile = value.endsWith('.md') ? value : `${value}.md`;
          await this.plugin.saveSettings();
        })
      );

    // Status display
    pane.createEl('p', {
      text: this.isCollecting ? 'Collecting notes...' :
            (this.collectedData ?
              `Collected ${this.collectedData.length} notes.` :
              'No data collected yet.'),
      cls: 'collection-status'
    });

    // Word count stats (will be populated later)
    if (this.wordStats) {
      this.updateWordStats(); // Call updateWordStats to create/update the element
    } else {
      pane.createEl('div', {
        text: 'Calculating word statistics...',
        cls: 'word-count-stats'
      });
    }

    // Instructions
    pane.createEl('p', {
      text: 'Adjust settings and use buttons below to collect & export.',
      cls: 'collection-instructions'
    });
  }

  // Render the visualization (right) pane
  renderVisualizationPane() {
    const pane = this.rightPane;
    pane.empty();

    // Title
    pane.createEl('h3', { text: 'Note Relationship Graph' });

    // Container for visualization
    this.vizContainer = pane.createDiv({ cls: 'packup4ai-viz-container' });

    // Initial message
    if (this.isCollecting) {
      this.vizContainer.createEl('div', { text: 'Loading graph...' });
    } else if (!this.collectedData) {
      this.vizContainer.createEl('div', { text: 'No data to visualize yet.' });
    }
  }

  // Render D3 visualization
  async renderVisualization() {
    if (!this.collectedData || this.collectedData.length === 0) {
      this.vizContainer.empty();
      this.vizContainer.createEl('div', { text: 'No connected notes found.' });
      return;
    }

    try {
      // Load D3 if not already loaded
      if (!window.d3) {
        try {
          await this.plugin.loadD3();
        } catch (error) {
          this.vizContainer.empty();
          this.vizContainer.createEl('div', {
            cls: 'packup4ai-error',
            text: 'Failed to load D3.js. Visualization not available.'
          });
          return;
        }
      }

      // Convert data to D3 format
      const nodes = this.collectedData.map(item => {
        // Count words for node sizing
        const wordCount = this.plugin.countWords(item.content);

        return {
          id: item.file.path,
          name: item.file.basename,
          depth: item.depth,
          wordCount: wordCount
        };
      });

      const links = this.collectedData
        .filter(item => item.parentPath)
        .map(item => ({
          source: item.parentPath,
          target: item.file.path
        }));

      // Clear previous visualization
      this.vizContainer.empty();
      if (this.simulation) this.simulation.stop();

      // Create SVG
      const width = this.vizContainer.clientWidth;
      const height = this.vizContainer.clientHeight;

      const svg = d3.create('svg')
        .attr('viewBox', [0, 0, width, height]);

      this.vizContainer.appendChild(svg.node());

      // Find min/max word counts for scaling node sizes
      const wordCounts = nodes.map(d => d.wordCount);
      const minWords = wordCounts.length > 0 ? Math.min(...wordCounts) : 0;
      const maxWords = wordCounts.length > 0 ? Math.max(...wordCounts) : 1; // Avoid division by zero if maxWords is 0

      // Scale node size based on word count (ensure domain is valid)
      const sizeScale = d3.scaleSqrt()
        .domain([Math.max(0, minWords), Math.max(1, maxWords)]) // Ensure domain starts at 0 and has a non-zero maximum
        .range([5, 15]);  // Range of sizes from 5px to 15px

      // Define forces
      const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-250))
        .force('center', d3.forceCenter(width / 2, height / 2));

      // Create link lines
      const link = svg.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 1.5);

      // Create node circles - now sized by word count
      const node = svg.append('g')
        .selectAll('circle')
        .data(nodes)
        .join('circle')
        .attr('r', d => sizeScale(Math.max(0, d.wordCount))) // Dynamic sizing, ensure non-negative input
        .attr('fill', d => d3.schemeCategory10[d.depth % 10])
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .call(this.dragBehavior(simulation));

      // Add tooltips on hover showing name and word count
      node.append('title')
        .text(d => `${d.name}\n${d.wordCount.toLocaleString()} words`);

      // Add node labels
      const label = svg.append('g')
        .attr('class', 'labels')
        .selectAll('text')
        .data(nodes)
        .join('text')
        .attr('class', 'node-label')
        .attr('dx', d => sizeScale(Math.max(0, d.wordCount)) + 2) // Position based on node size
        .attr('dy', '.35em')
        .text(d => d.name);

      // Handle node clicks to open the corresponding file
      node.on('click', (event, d) => {
        const file = this.app.vault.getAbstractFileByPath(d.id);
        if (file instanceof TFile) { // Make sure it's a file before opening
            this.app.workspace.getLeaf().openFile(file);
        }
      });

      // Update positions on each tick of the simulation
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);

        label
          .attr('x', d => d.x)
          .attr('y', d => d.y);
      });

      // Add zoom capability with a slightly higher initial scale
      const zoomBehavior = d3.zoom()
        .extent([[0, 0], [width, height]])
        .scaleExtent([0.2, 8])
        .on('zoom', event => {
          svg.selectAll('g').attr('transform', event.transform);
        });

      // Apply zoom behavior to SVG
      svg.call(zoomBehavior);

      // Set initial transform (zoom level)
      svg.call(zoomBehavior.transform, d3.zoomIdentity.scale(1.2));

      // Store simulation for cleanup
      this.simulation = simulation;

    } catch (error) {
      console.error('Visualization error:', error);
      this.vizContainer.empty();
      this.vizContainer.createEl('div', {
        cls: 'packup4ai-error',
        text: `Error creating visualization: ${error.message}`
      });
    }
  }

  // D3 drag behavior for nodes
  dragBehavior(simulation) {
    return d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }
}

module.exports = Packup4AIPlugin;
