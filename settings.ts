import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TraverturePlugin from "./main";
import { getAvailableLanguages } from "./languages";

export class TravertureSettingTab extends PluginSettingTab {
  plugin: TraverturePlugin;

  constructor(app: App, plugin: TraverturePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async chooseAndImportEpub(overwriteExisting = false): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,application/epub+zip";
    input.style.display = "none";

    const done = new Promise<void>((resolve) => {
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) return;

          if (!this.plugin.epubImportService) {
            new Notice("EPUB importer not initialized.");
            return;
          }

          const data = new Uint8Array(await file.arrayBuffer());
          const result = await this.plugin.epubImportService.importEpub(
            data,
            file.name,
            overwriteExisting,
          );

          if (!result.success) {
            new Notice(`EPUB import failed: ${result.error ?? "unknown"}`);
          } else {
            new Notice(`Imported offline corpus: ${result.metadata?.language}`);
          }
        } finally {
          input.remove();
          resolve();
        }
      };
    });

    document.body.appendChild(input);
    input.click();
    await done;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const headerEl = containerEl.createDiv({ cls: "traverture-settings-header" });
    headerEl.createSpan({ text: "tra.VER:ture", cls: "traverture-settings-title" });
    headerEl.createSpan({
      text: `v${this.plugin.manifest.version}`,
      cls: "traverture-version-info",
    });

    const languages = getAvailableLanguages();

    new Setting(containerEl)
      .setName("Source language")
      .setDesc("Language of the scripture references in your notes")
      .addDropdown((dropdown) => {
        for (const language of languages.filter((item) => item.code !== "ase")) {
          dropdown.addOption(
            language.code,
            `${language.vernacularName} (${language.code})`,
          );
        }
        dropdown
          .setValue(this.plugin.settings.sourceLanguage)
          .onChange(async (value) => {
            this.plugin.settings.sourceLanguage = value;
            await this.plugin.saveSettings();
            this.plugin.createEngine();
          });
      });

    new Setting(containerEl)
      .setName("Output language")
      .setDesc("Language for displaying and fetching scripture text")
      .addDropdown((dropdown) => {
        for (const language of languages) {
          dropdown.addOption(
            language.code,
            `${language.vernacularName} (${language.code})`,
          );
        }
        dropdown
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (value) => {
            this.plugin.settings.outputLanguage = value;
            await this.plugin.saveSettings();
            this.plugin.createEngine();
          });
      });

    new Setting(containerEl)
      .setName("Modal title format")
      .setDesc("How scripture references are displayed in the modal title")
      .addDropdown((dropdown) => {
        dropdown.addOption("full", "Full (1 Corinthians)");
        dropdown.addOption("standard", "Standard (1 Cor.)");
        dropdown.addOption("official", "Official (1Co)");
        dropdown
          .setValue(this.plugin.settings.titleFormat)
          .onChange(async (value) => {
            this.plugin.settings.titleFormat = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-detect references")
      .setDesc("Automatically detect scripture references in View mode without {{ }} markers.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoDetect)
          .onChange(async (value) => {
            this.plugin.settings.autoDetect = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("JW link scheme")
      .setDesc("Choose how scripture links are opened: popup (modal preview), JW Library app, or JW.org.")
      .addDropdown((dropdown) => {
        dropdown.addOption("popup", "Popup preview (modal)");
        dropdown.addOption(
          "jwlibrary",
          "Open via jwlibrary:// (native JW Library app)",
        );
        dropdown.addOption("jworg", "Open via jworg:// (JW.org handler)");

        const scheme = this.plugin.settings.linkScheme === "jworg"
          ? "jworg"
          : this.plugin.settings.linkScheme === "popup"
            ? "popup"
            : "jwlibrary";

        dropdown
          .setValue(scheme)
          .onChange(async (value) => {
            this.plugin.settings.linkScheme =
              value === "jworg" ? "jworg" : value === "popup" ? "popup" : "jwlibrary";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Import EPUB for offline lookup")
      .setDesc("Upload an EPUB file to enable offline citation lookup stored in the vault.")
      .addButton((button) =>
        button.setButtonText("Import EPUB").onClick(async () => {
          await this.chooseAndImportEpub(false);
          this.display();
        }),
      );

    const activeLanguage = this.plugin.settings.outputLanguage;
    void this.renderOfflineCorpusSetting(containerEl, activeLanguage);
  }

  private async renderOfflineCorpusSetting(
    containerEl: HTMLElement,
    activeLanguage: string,
  ): Promise<void> {
    const metadata = await this.plugin.offlineRepo?.getMetadata(activeLanguage);

    new Setting(containerEl)
      .setName("Offline EPUB corpus")
      .setDesc(
        metadata
          ? `Current offline corpus for ${activeLanguage}: ${metadata.fileName} (${metadata.chapterCount ?? 0} chapters)`
          : `No offline corpus imported for ${activeLanguage}.`,
      )
      .addButton((button) =>
        button
          .setButtonText("Replace EPUB")
          .setDisabled(!metadata)
          .onClick(async () => {
            await this.chooseAndImportEpub(true);
            this.display();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Delete EPUB")
          .setWarning()
          .setDisabled(!metadata)
          .onClick(async () => {
            if (!this.plugin.offlineRepo) {
              new Notice("Offline EPUB repository not initialized.");
              return;
            }
            await this.plugin.offlineRepo.removeLanguage(activeLanguage);
            new Notice(`Deleted offline corpus for ${activeLanguage}.`);
            this.display();
          }),
      );
  }
}

export default TravertureSettingTab;
