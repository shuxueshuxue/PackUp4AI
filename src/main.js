const { Plugin, PluginSettingTab, Notice, Modal, Setting, TFile, normalizePath, getFrontMatterInfo } = require('obsidian');

// --- Constants ---
const PLUGIN_NAME = 'packup4AI';
const MODAL_TITLE = 'Packup4AI notes explorer';

class Packup4AIPlugin extends Plugin {
  settings = {
    maxDepth: 3,
    excludePaths: ["packup4ai-output.md"], // Default excluded file matches output
    outputFile: "packup4ai-output.md",
    includeBacklinks: true,
  };
  
  d3 = null; // Will be loaded in onload()

  async onload() {
    // if (process.env.NODE_ENV === 'development') {
    //   console.log(`Loading ${PLUGIN_NAME}`);
    // }
    
    // Dynamically import D3 only when plugin loads
    try {
      const d3Module = await import('d3');
      this.d3 = d3Module;
      // Make D3 available to modal windows
      // if (process.env.NODE_ENV === 'development') {
      //   console.log('D3 loaded successfully into plugin');
      // }
    } catch (error) {
      new Notice('Failed to load D3 visualization library');
      // console.error('Failed to load D3:', error);
    }

    // Load settings
    this.settings = Object.assign({}, this.settings, await this.loadData());

    // Register command
    this.addCommand({
      id: 'collect-notes',
      name: 'Collect notes for AI context',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) {
            new PackupModal(this.app, this).open();
          }
          return true;
        }
        return false;
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

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    // Clean up D3 reference
    if (this.d3) {
      this.d3 = null;
    }
  }

  // Core collection function
  async collectRelatedNotes(startFile, maxDepth) {
    // if (process.env.NODE_ENV === 'development') {
    //   console.log(`Starting collection from ${startFile.path} with depth ${maxDepth}`);
    // }

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
              // console.warn(`Error reading file ${neighbor.path}:`, error);
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
      // console.error("Collection error:", error);
      throw new Error(`Collection failed: ${error.message}`);
    }

    // if (process.env.NODE_ENV === 'development') {
    //   console.log(`Collected ${collected.length} notes`);
    // }
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
  countWords(text, file = null) {
    if (!text) return 0;

    // Remove frontmatter using Obsidian's built-in function
    let cleanText = text;
    if (file) {
      const frontmatter = getFrontMatterInfo(text);
      if (frontmatter.exists) {
        cleanText = text.substring(frontmatter.contentStart).trim();
      }
    } else {
      // Fallback for cases where file is not available
      cleanText = text.replace(/^---\s*[\s\S]*?---\s*/, '').trim();
    }

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
    const wordCounts = collected.map(item => this.countWords(item.content, item.file));

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
      if (d === 0) sectionTitle = `Starting file: ${startName}`;
      else if (d === 1) sectionTitle = `Directly linked files`;
      else sectionTitle = `Files ${d} hops away`;

      md += `## ${sectionTitle} (Depth ${d})\n\n`;

      // Add each note in the group
      for (const item of group) {
        md += `### ${item.file.basename}  \n`;
        md += `Path: ${item.file.path}\n\n`;

        // Clean content (remove frontmatter)
        const frontmatter = getFrontMatterInfo(item.content);
        const clean = frontmatter.exists ? 
          item.content.substring(frontmatter.contentStart).trim() : 
          item.content.trim();

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
      // console.error(`Error writing file ${filename}:`, error);
      new Notice(`Error saving file: ${error.message}`);
      return false;
    }
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

    new Setting(containerEl)
      .setName("Max collection depth")
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
      .setName("Include backlinks")
      .setDesc("Also collect notes that link to the notes being processed.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeBacklinks)
        .onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default output filename")
      .setDesc("Filename for the exported Markdown file.")
      .addText(text => text
        .setPlaceholder("e.g., packup4ai-output.md")
        .setValue(this.plugin.settings.outputFile)
        .onChange(async (value) => {
          const normalized = normalizePath(value.endsWith('.md') ? value : `${value}.md`);
          this.plugin.settings.outputFile = normalized;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Excluded files/folders")
      .setDesc("Paths to exclude from collection (one per line). Folders must end with '/'.")
      .addTextArea(text => text
        .setPlaceholder("e.g., Templates/\nDrafts/ignore.md")
        .setValue((this.plugin.settings.excludePaths || []).join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludePaths = value
            .split("\n")
            .map(p => normalizePath(p.trim()))
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
      text: 'Collect & copy to clipboard',
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
      text: 'Collect & save to file'
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
      // if (process.env.NODE_ENV === 'development') {
      //   console.log(`Starting collection with depth ${this.plugin.settings.maxDepth}`);
      // }
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

      // if (process.env.NODE_ENV === 'development') {
      //   console.log(`Collection completed: ${data.length} notes`);
      // }

      // Only render visualization if the collection changed
      if (hasChanged) {
        // if (process.env.NODE_ENV === 'development') {
        //   console.log("Collection changed, updating visualization");
        // }
        this.renderVisualization();
      } else {
        // if (process.env.NODE_ENV === 'development') {
        //   console.log("Collection unchanged, skipping visualization refresh");
        // }
      }

    } catch (error) {
      // console.error('Collection error:', error);
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
    pane.createEl('h3', { text: 'Collection settings' });

    // Starting note info
    pane.createEl('div', {
      text: `Starting note: ${this.currentFile.basename}`
    });

    // Depth slider with visual indicator
    const depthSetting = new Setting(pane)
      .setName('Collection depth');

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
      .setName('Include backlinks')
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
      .setName('Output filename')
      .setDesc('Filename for saving the collected notes.')
      .addText(text => text
        .setValue(this.plugin.settings.outputFile)
        .onChange(async (value) => {
          const normalized = normalizePath(value.endsWith('.md') ? value : `${value}.md`);
          this.plugin.settings.outputFile = normalized;
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
    pane.createEl('h3', { text: 'Note relationship graph' });

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
      // Check if D3 is available from the plugin
      if (!this.plugin.d3) {
        this.vizContainer.empty();
        this.vizContainer.createEl('div', {
          cls: 'packup4ai-error',
          text: 'D3.js not available. Visualization cannot be rendered.'
        });
        return;
      }
      
      // Use d3 from the plugin instance
      const d3 = this.plugin.d3;

      // Convert data to D3 format
      const nodes = this.collectedData.map(item => {
        // Count words for node sizing
        const wordCount = this.plugin.countWords(item.content, item.file);

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
      // console.error('Visualization error:', error);
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
