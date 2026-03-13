import { useRef } from "react";
import type { ChangeEvent, CSSProperties, FormEvent } from "react";
import {
  THEME_FONT_OPTIONS,
  THEME_PRESETS,
  resolveAppTheme,
  resolveThemeFont,
} from "../lib/theme";
import type {
  AgentBackendId,
  AppSettings,
  NotificationAudioDefaultSoundId,
  NotificationAudioMode,
  NotificationAudioTone,
  ThemePresetId,
} from "../types";
import {
  EmptyState,
  MetricCard,
  PageIntro,
  SectionCard,
  StatusBadge,
} from "../components/primitives";

type SettingsPageProps = {
  onSettingsChange: (settings: AppSettings) => void;
  onImportNotificationAudio: (
    tone: NotificationAudioTone,
    file: File,
  ) => Promise<void>;
  onPreviewNotification: (tone: NotificationAudioTone) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  previewingNotificationTone: NotificationAudioTone | null;
  savingSettings: boolean;
  settings: AppSettings | null;
  settingsConfigured: boolean;
  settingsMessage: string | null;
  uploadingNotificationAudioTone: NotificationAudioTone | null;
};

type SectionSummary = {
  complete: number;
  items: number;
  label: string;
  ready: boolean;
};

type ThemeCard = {
  accentColor: string;
  backgroundColor: string;
  description: string;
  fontLabel: string;
  foregroundColor: string;
  id: ThemePresetId;
  label: string;
};

type AgentBackendOption = {
  description: string;
  id: AgentBackendId;
  label: string;
};

const AGENT_BACKEND_OPTIONS: AgentBackendOption[] = [
  {
    description: "OpenAI Codex CLI for autonomous coding tasks.",
    id: "codex",
    label: "Codex (OpenAI)",
  },
  {
    description: "Anthropic Claude Code CLI for autonomous coding tasks.",
    id: "claude-code",
    label: "Claude Code (Anthropic)",
  },
  {
    description: "Cursor AI coding assistant CLI.",
    id: "cursor",
    label: "Cursor",
  },
];

type NotificationAudioModeCard = {
  description: string;
  id: NotificationAudioMode;
  label: string;
};

type NotificationAudioSoundCard = {
  description: string;
  id: NotificationAudioDefaultSoundId;
  label: string;
};

type NotificationAudioProfileState = {
  customPath: string;
  defaultSound: NotificationAudioDefaultSoundId;
  mode: NotificationAudioMode;
};

type NotificationAudioProfileCard = {
  description: string;
  previewCopy: string;
  title: string;
  tone: NotificationAudioTone;
};

const NOTIFICATION_AUDIO_MODE_CARDS: NotificationAudioModeCard[] = [
  {
    description: "Keep Watchtower desktop notifications silent.",
    id: "off",
    label: "No Sound",
  },
  {
    description: "Use a built-in macOS alert sound for every notification.",
    id: "default",
    label: "Built-in Sounds",
  },
  {
    description: "Import your own audio file and store it with Watchtower.",
    id: "custom",
    label: "Custom File",
  },
];

const NOTIFICATION_AUDIO_SOUND_CARDS: NotificationAudioSoundCard[] = [
  { description: "Low, warm tap", id: "basso", label: "Basso" },
  { description: "Bright glass chime", id: "glass", label: "Glass" },
  { description: "Confident upward tone", id: "hero", label: "Hero" },
  { description: "Classic single ping", id: "ping", label: "Ping" },
  { description: "Short rounded pop", id: "pop", label: "Pop" },
  { description: "Soft synthetic pulse", id: "purr", label: "Purr" },
  { description: "Retro system chirp", id: "sosumi", label: "Sosumi" },
  { description: "Deep submarine ping", id: "submarine", label: "Submarine" },
  { description: "Small crystal tick", id: "tink", label: "Tink" },
];

function buildThemePreviewStyle(
  theme: ReturnType<typeof resolveAppTheme>,
): CSSProperties {
  return {
    "--theme-preview-accent": theme.accentColor,
    "--theme-preview-bg": theme.backgroundColor,
    "--theme-preview-font": theme.font.stack,
    "--theme-preview-fg": theme.foregroundColor,
  } as CSSProperties;
}

function readFileNameFromPath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function readNotificationAudioProfile(
  settings: AppSettings,
  tone: NotificationAudioTone,
): NotificationAudioProfileState {
  if (tone === "success") {
    return {
      mode: settings.successNotificationAudioMode,
      defaultSound: settings.successNotificationAudioDefaultSound,
      customPath: settings.successNotificationAudioCustomPath,
    };
  }

  return {
    mode: settings.failureNotificationAudioMode,
    defaultSound: settings.failureNotificationAudioDefaultSound,
    customPath: settings.failureNotificationAudioCustomPath,
  };
}

function buildNotificationAudioProfilePatch(
  tone: NotificationAudioTone,
  patch: Partial<NotificationAudioProfileState>,
): Partial<AppSettings> {
  if (tone === "success") {
    return {
      ...(patch.mode ? { successNotificationAudioMode: patch.mode } : {}),
      ...(patch.defaultSound
        ? { successNotificationAudioDefaultSound: patch.defaultSound }
        : {}),
      ...(patch.customPath !== undefined
        ? { successNotificationAudioCustomPath: patch.customPath }
        : {}),
    };
  }

  return {
    ...(patch.mode ? { failureNotificationAudioMode: patch.mode } : {}),
    ...(patch.defaultSound
      ? { failureNotificationAudioDefaultSound: patch.defaultSound }
      : {}),
    ...(patch.customPath !== undefined
      ? { failureNotificationAudioCustomPath: patch.customPath }
      : {}),
  };
}

export function SettingsPage({
  onSettingsChange,
  onImportNotificationAudio,
  onPreviewNotification,
  onSubmit,
  previewingNotificationTone,
  savingSettings,
  settings,
  settingsConfigured,
  settingsMessage,
  uploadingNotificationAudioTone,
}: SettingsPageProps) {
  const successNotificationAudioInputRef = useRef<HTMLInputElement | null>(
    null,
  );
  const failureNotificationAudioInputRef = useRef<HTMLInputElement | null>(
    null,
  );

  if (!settings) {
    return (
      <div className="page-stack">
        <PageIntro
          eyebrow="Runtime + Appearance"
          title="Settings"
          description="Slack authentication, ownership, repo path, runtime limits, and desktop appearance all live here."
        />
        <SectionCard
          title="Loading Settings"
          subtitle="Pulling runtime configuration and theme state from the local database."
        >
          <EmptyState>Loading settings.</EmptyState>
        </SectionCard>
      </div>
    );
  }

  const isAbsolutePath = (value: string) => value.trim().startsWith("/");
  const hasCommaList = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean).length > 0;
  const updateSettings = (patch: Partial<AppSettings>) =>
    onSettingsChange({ ...settings, ...patch });
  const activeTheme = resolveAppTheme(settings);
  const customThemePreview = resolveAppTheme({
    ...settings,
    themePreset: "custom",
  });
  const notificationAudioProfiles: NotificationAudioProfileCard[] = [
    {
      tone: "success",
      title: "Success Notifications",
      description:
        "Play a distinct sound when miniOG or other Watchtower work finishes successfully.",
      previewCopy:
        "Preview the success path using the current in-form settings before you save.",
    },
    {
      tone: "failure",
      title: "Failure Notifications",
      description:
        "Play a separate alert when workflows fail, the sidecar crashes, or launch intake is blocked.",
      previewCopy:
        "Preview the failure path using the current in-form settings before you save.",
    },
  ];
  const themeCards: ThemeCard[] = [
    ...THEME_PRESETS.map((preset) => ({
      accentColor: preset.accentColor,
      backgroundColor: preset.backgroundColor,
      description: preset.description,
      fontLabel: resolveThemeFont(preset.fontFamily).label,
      foregroundColor: preset.foregroundColor,
      id: preset.id,
      label: preset.label,
    })),
    {
      accentColor: customThemePreview.accentColor,
      backgroundColor: customThemePreview.backgroundColor,
      description: "Manual background, foreground, accent, and font selection.",
      fontLabel: customThemePreview.font.label,
      foregroundColor: customThemePreview.foregroundColor,
      id: "custom",
      label: "Custom",
    },
  ];
  const themePreviewStyle = buildThemePreviewStyle(activeTheme);

  const handleNotificationAudioFileChange =
    (tone: NotificationAudioTone) =>
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }

      await onImportNotificationAudio(tone, file);
    };

  const sections: SectionSummary[] = [
    {
      label: "Slack Auth",
      complete: [
        settings.slackBotToken,
        settings.slackAppToken,
        settings.botUserId,
      ].filter((value) => value.trim()).length,
      items: 3,
      ready: Boolean(
        settings.slackBotToken.trim() &&
        settings.slackAppToken.trim() &&
        settings.botUserId.trim(),
      ),
    },
    {
      label: "Ownership / Channels",
      complete: [
        hasCommaList(settings.ownerSlackUserIds),
        hasCommaList(settings.bugsAndUpdatesChannelId),
      ].filter(Boolean).length,
      items: 2,
      ready:
        hasCommaList(settings.ownerSlackUserIds) &&
        hasCommaList(settings.bugsAndUpdatesChannelId),
    },
    {
      label: "Repo Paths",
      complete: [
        isAbsolutePath(settings.newtonWebPath),
        isAbsolutePath(settings.newtonApiPath),
      ].filter(Boolean).length,
      items: 2,
      ready:
        isAbsolutePath(settings.newtonWebPath) &&
        isAbsolutePath(settings.newtonApiPath),
    },
    {
      label: "Runtime Limits",
      complete: [
        settings.maxConcurrentJobs >= 1 && settings.maxConcurrentJobs <= 10,
        settings.prReviewTimeoutMs > 0,
        settings.bugFixTimeoutMs > 0,
        settings.repoClassifierThreshold >= 0 &&
          settings.repoClassifierThreshold <= 1,
      ].filter(Boolean).length,
      items: 4,
      ready:
        settings.maxConcurrentJobs >= 1 &&
        settings.maxConcurrentJobs <= 10 &&
        settings.prReviewTimeoutMs > 0 &&
        settings.bugFixTimeoutMs > 0 &&
        settings.repoClassifierThreshold >= 0 &&
        settings.repoClassifierThreshold <= 1,
    },
  ];

  const completeSections = sections.filter((section) => section.ready).length;

  return (
    <div className="page-stack settings-page">
      <PageIntro
        eyebrow="Runtime + Appearance"
        title="Settings"
        description="Slack auth, ownership rules, repo boundaries, execution limits, desktop appearance, and notification audio all live in one polished configuration surface."
        actions={
          <StatusBadge
            label={settingsConfigured ? "Runtime Ready" : "Action Needed"}
            tone={settingsConfigured ? "success" : "warn"}
          />
        }
      />

      <form className="settings-form-page" onSubmit={onSubmit}>
        <SectionCard
          title="Completeness Summary"
          subtitle="Runtime readiness still mirrors the backend contract. Theme choices are optional and save alongside the required runtime fields."
          count={`${completeSections}/${sections.length}`}
        >
          <div className="settings-summary-grid">
            <MetricCard
              label="Sections Ready"
              value={`${completeSections}/${sections.length}`}
              tone={settingsConfigured ? "success" : "warning"}
            />
            <MetricCard
              label="Runtime Status"
              value={settingsConfigured ? "Ready" : "Incomplete"}
              tone={settingsConfigured ? "success" : "danger"}
            />
            <MetricCard
              label="Active Theme"
              value={activeTheme.label}
              tone="accent"
            />
            {sections.map((section) => (
              <article className="settings-summary-card" key={section.label}>
                <div className="settings-summary-top">
                  <strong>{section.label}</strong>
                  <StatusBadge
                    label={section.ready ? "Ready" : "Pending"}
                    tone={section.ready ? "success" : "warn"}
                  />
                </div>
                <p>
                  {section.complete}/{section.items} checks complete
                </p>
              </article>
            ))}
          </div>
        </SectionCard>

        <div className="settings-sections">
          <SectionCard
            title="Theme"
            subtitle="Presets repaint background, foreground, accent, and typography across the desktop shell. Select Custom to unlock manual pickers."
          >
            <div className="theme-section-layout">
              <div className="theme-presets-grid">
                {themeCards.map((card) => {
                  const selected = settings.themePreset === card.id;

                  return (
                    <button
                      key={card.id}
                      className={
                        selected
                          ? "theme-preset-card active"
                          : "theme-preset-card"
                      }
                      type="button"
                      onClick={() => updateSettings({ themePreset: card.id })}
                    >
                      <div className="theme-preset-top">
                        <div>
                          <strong>{card.label}</strong>
                          <p>{card.description}</p>
                        </div>
                        <StatusBadge
                          label={
                            selected
                              ? "Active"
                              : card.id === "custom"
                                ? "Manual"
                                : "Preset"
                          }
                          tone={selected ? "success" : "info"}
                        />
                      </div>

                      <div className="theme-swatch-strip" aria-hidden="true">
                        <span
                          style={{ backgroundColor: card.backgroundColor }}
                        />
                        <span
                          style={{ backgroundColor: card.foregroundColor }}
                        />
                        <span style={{ backgroundColor: card.accentColor }} />
                      </div>

                      <div className="theme-preset-meta">
                        <span>{card.fontLabel}</span>
                        <span>{card.accentColor}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <article className="theme-preview-card" style={themePreviewStyle}>
                <div className="theme-preview-top">
                  <div>
                    <p className="theme-preview-kicker">Live Preview</p>
                    <h3>{activeTheme.label}</h3>
                  </div>
                  <StatusBadge
                    label={activeTheme.isCustom ? "Custom" : "Preset"}
                    tone="info"
                  />
                </div>

                <p className="theme-preview-copy">{activeTheme.description}</p>

                <div className="theme-preview-surface">
                  <div className="theme-preview-line">
                    <span>Watchtower</span>
                    <span>{activeTheme.font.label}</span>
                  </div>
                  <strong>Sidecar healthy. Queue under control.</strong>
                  <p>
                    Background, foreground, accent, and type update live while
                    you edit settings.
                  </p>
                  <div className="theme-preview-actions">
                    <button type="button">Primary Action</button>
                    <span>{activeTheme.accentColor}</span>
                  </div>
                </div>
              </article>
            </div>

            {settings.themePreset === "custom" ? (
              <div className="settings-fields two-column theme-custom-grid">
                <label className="field">
                  <span>Background Color</span>
                  <div className="theme-color-control">
                    <input
                      type="color"
                      value={settings.themeBackgroundColor}
                      onChange={(event) =>
                        updateSettings({
                          themeBackgroundColor:
                            event.target.value.toUpperCase(),
                        })
                      }
                    />
                    <strong>
                      {settings.themeBackgroundColor.toUpperCase()}
                    </strong>
                  </div>
                </label>

                <label className="field">
                  <span>Foreground Color</span>
                  <div className="theme-color-control">
                    <input
                      type="color"
                      value={settings.themeForegroundColor}
                      onChange={(event) =>
                        updateSettings({
                          themeForegroundColor:
                            event.target.value.toUpperCase(),
                        })
                      }
                    />
                    <strong>
                      {settings.themeForegroundColor.toUpperCase()}
                    </strong>
                  </div>
                </label>

                <label className="field">
                  <span>Accent Color</span>
                  <div className="theme-color-control">
                    <input
                      type="color"
                      value={settings.themeAccentColor}
                      onChange={(event) =>
                        updateSettings({
                          themeAccentColor: event.target.value.toUpperCase(),
                        })
                      }
                    />
                    <strong>{settings.themeAccentColor.toUpperCase()}</strong>
                  </div>
                </label>

                <label className="field">
                  <span>Font Family</span>
                  <select
                    value={settings.themeFontFamily}
                    onChange={(event) =>
                      updateSettings({
                        themeFontFamily: event.target
                          .value as AppSettings["themeFontFamily"],
                      })
                    }
                  >
                    {THEME_FONT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} - {option.note}
                      </option>
                    ))}
                  </select>
                  <small className="field-hint">
                    Custom values preview instantly and save with the rest of
                    your local app settings.
                  </small>
                </label>
              </div>
            ) : (
              <p className="muted theme-custom-hint">
                Switch to Custom if you want to pick the exact colors and font
                family yourself.
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Notification Audio"
            subtitle="Configure distinct success and failure sounds. Each profile can stay silent, use a built-in macOS alert, or import a custom file."
          >
            <div className="audio-profile-grid">
              {notificationAudioProfiles.map((profile) => {
                const profileSettings = readNotificationAudioProfile(
                  settings,
                  profile.tone,
                );
                const customNotificationAudioFile = readFileNameFromPath(
                  profileSettings.customPath,
                );
                const activeNotificationAudioLabel =
                  profileSettings.mode === "off"
                    ? "Silent"
                    : profileSettings.mode === "custom"
                      ? (customNotificationAudioFile ?? "Custom file")
                      : (NOTIFICATION_AUDIO_SOUND_CARDS.find(
                          (sound) => sound.id === profileSettings.defaultSound,
                        )?.label ?? "Built-in sound");
                const canPreviewNotification =
                  profileSettings.mode !== "custom" ||
                  Boolean(customNotificationAudioFile);
                const inputRef =
                  profile.tone === "success"
                    ? successNotificationAudioInputRef
                    : failureNotificationAudioInputRef;
                const isUploading =
                  uploadingNotificationAudioTone === profile.tone;
                const isPreviewing =
                  previewingNotificationTone === profile.tone;
                const toneLabel =
                  profile.tone === "success" ? "Success" : "Failure";

                return (
                  <article className="audio-profile-card" key={profile.tone}>
                    <div className="settings-choice-top">
                      <div>
                        <strong>{profile.title}</strong>
                        <p>{profile.description}</p>
                      </div>
                      <StatusBadge
                        label={toneLabel}
                        tone={profile.tone === "success" ? "success" : "warn"}
                      />
                    </div>

                    <div className="audio-mode-grid">
                      {NOTIFICATION_AUDIO_MODE_CARDS.map((card) => {
                        const selected = profileSettings.mode === card.id;

                        return (
                          <button
                            key={card.id}
                            className={
                              selected
                                ? "settings-choice-card active"
                                : "settings-choice-card"
                            }
                            type="button"
                            onClick={() =>
                              updateSettings(
                                buildNotificationAudioProfilePatch(
                                  profile.tone,
                                  { mode: card.id },
                                ),
                              )
                            }
                          >
                            <div className="settings-choice-top">
                              <strong>{card.label}</strong>
                              <StatusBadge
                                label={selected ? "Selected" : "Available"}
                                tone={selected ? "success" : "info"}
                              />
                            </div>
                            <p>{card.description}</p>
                          </button>
                        );
                      })}
                    </div>

                    {profileSettings.mode === "default" ? (
                      <div className="audio-sound-grid">
                        {NOTIFICATION_AUDIO_SOUND_CARDS.map((sound) => {
                          const selected =
                            profileSettings.defaultSound === sound.id;

                          return (
                            <button
                              key={sound.id}
                              className={
                                selected
                                  ? "settings-choice-card active"
                                  : "settings-choice-card"
                              }
                              type="button"
                              onClick={() =>
                                updateSettings(
                                  buildNotificationAudioProfilePatch(
                                    profile.tone,
                                    { defaultSound: sound.id },
                                  ),
                                )
                              }
                            >
                              <div className="settings-choice-top">
                                <strong>{sound.label}</strong>
                                <StatusBadge
                                  label={selected ? "Active" : "Sound"}
                                  tone={selected ? "success" : "info"}
                                />
                              </div>
                              <p>{sound.description}</p>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {profileSettings.mode === "custom" ? (
                      <div className="audio-custom-card">
                        <div>
                          <p className="theme-preview-kicker">Imported File</p>
                          <strong>
                            {customNotificationAudioFile ??
                              "No custom audio selected yet"}
                          </strong>
                          <p className="theme-preview-copy">
                            Supported formats: `.aiff`, `.aif`, `.wav`, `.mp3`,
                            `.m4a`, `.caf`. Watchtower copies the file into
                            local app storage and reuses it for future
                            notifications.
                          </p>
                        </div>

                        <div className="audio-custom-actions">
                          <input
                            ref={inputRef}
                            type="file"
                            accept=".aiff,.aif,.wav,.mp3,.m4a,.caf,audio/*"
                            onChange={handleNotificationAudioFileChange(
                              profile.tone,
                            )}
                            hidden
                          />

                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            disabled={uploadingNotificationAudioTone !== null}
                          >
                            {isUploading
                              ? "Importing..."
                              : customNotificationAudioFile
                                ? "Replace Audio File"
                                : "Choose Audio File"}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="notification-preview-strip">
                      <div>
                        <p className="theme-preview-kicker">
                          {toneLabel} Preview
                        </p>
                        <strong>
                          {profileSettings.mode === "off"
                            ? `${toneLabel} notifications stay silent.`
                            : `Current sound: ${activeNotificationAudioLabel}`}
                        </strong>
                        <p className="theme-preview-copy">
                          {profile.previewCopy} Uses the same Tauri event path
                          as a real sidecar notification so you can inspect the
                          in-app toast styling and hear the selected alert
                          sound.
                        </p>
                      </div>

                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => onPreviewNotification(profile.tone)}
                        disabled={
                          previewingNotificationTone !== null ||
                          uploadingNotificationAudioTone !== null ||
                          !canPreviewNotification
                        }
                      >
                        {isPreviewing
                          ? "Playing Preview..."
                          : `Preview ${toneLabel}`}
                      </button>
                    </div>

                    {profileSettings.mode === "custom" &&
                    !customNotificationAudioFile ? (
                      <p className="error">
                        Pick a file before saving custom mode.
                      </p>
                    ) : (
                      <p className="field-hint">
                        Built-in sounds use `/System/Library/Sounds`. Custom
                        uploads stay local to this Mac.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard
            title="Slack Auth"
            subtitle="Tokens and bot identity used to establish the Slack socket connection."
          >
            <div className="settings-fields two-column">
              <label className="field">
                <span>Slack Bot Token</span>
                <input
                  type="password"
                  value={settings.slackBotToken}
                  onChange={(event) =>
                    updateSettings({ slackBotToken: event.target.value })
                  }
                  placeholder="xoxb-..."
                />
              </label>

              <label className="field">
                <span>Slack App Token</span>
                <input
                  type="password"
                  value={settings.slackAppToken}
                  onChange={(event) =>
                    updateSettings({ slackAppToken: event.target.value })
                  }
                  placeholder="xapp-..."
                />
              </label>

              <label className="field">
                <span>Bot Slack User ID</span>
                <input
                  type="text"
                  value={settings.botUserId}
                  onChange={(event) =>
                    updateSettings({ botUserId: event.target.value })
                  }
                  placeholder="U0BOTUSER"
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title="Ownership / Channels"
            subtitle="Who owns Watchtower and where bug-fix workflows are allowed to auto-run."
          >
            <div className="settings-fields two-column">
              <label className="field">
                <span>Owner Slack User IDs</span>
                <input
                  type="text"
                  value={settings.ownerSlackUserIds}
                  onChange={(event) =>
                    updateSettings({ ownerSlackUserIds: event.target.value })
                  }
                  placeholder="U01234567,U07654321"
                />
              </label>

              <label className="field">
                <span>Bug-fix Channel IDs</span>
                <input
                  type="text"
                  value={settings.bugsAndUpdatesChannelId}
                  onChange={(event) =>
                    updateSettings({
                      bugsAndUpdatesChannelId: event.target.value,
                    })
                  }
                  placeholder="C01H25RNLJH,C02XXXXXXX"
                />
                <small className="field-hint">
                  Mentions are processed anywhere the bot is present. This list
                  only governs bug-fix auto-runs.
                </small>
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title="Repo Paths"
            subtitle="Absolute local directories that Watchtower is allowed to operate against."
          >
            <div className="settings-fields two-column">
              <label className="field">
                <span>newton-web Path</span>
                <input
                  type="text"
                  value={settings.newtonWebPath}
                  onChange={(event) =>
                    updateSettings({ newtonWebPath: event.target.value })
                  }
                  placeholder="/Users/you/code/newton-web"
                />
              </label>

              <label className="field">
                <span>newton-api Path</span>
                <input
                  type="text"
                  value={settings.newtonApiPath}
                  onChange={(event) =>
                    updateSettings({ newtonApiPath: event.target.value })
                  }
                  placeholder="/Users/you/code/newton-api"
                />
                <small className="field-hint">
                  Save-time validation requires absolute paths that already
                  exist on disk.
                </small>
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title="Runtime Limits / Timeouts"
            subtitle="Concurrency, execution windows, and repo classification sensitivity."
          >
            <div className="settings-fields two-column">
              <label className="field">
                <span>Max Concurrent Jobs</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.maxConcurrentJobs}
                  onChange={(event) =>
                    updateSettings({
                      maxConcurrentJobs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>PR Review Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={settings.prReviewTimeoutMs}
                  onChange={(event) =>
                    updateSettings({
                      prReviewTimeoutMs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>Bug Fix Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={settings.bugFixTimeoutMs}
                  onChange={(event) =>
                    updateSettings({
                      bugFixTimeoutMs: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>Repo Classifier Threshold</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.repoClassifierThreshold}
                  onChange={(event) =>
                    updateSettings({
                      repoClassifierThreshold: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title="Agent Backend"
            subtitle="Choose which AI coding CLI runs your workflows. The selected CLI must be installed and accessible from PATH."
          >
            <div className="settings-fields two-column">
              <label className="field">
                <span>Backend CLI</span>
                <select
                  value={settings.agentBackend}
                  onChange={(event) =>
                    updateSettings({
                      agentBackend: event.target
                        .value as AgentBackendId,
                    })
                  }
                >
                  {AGENT_BACKEND_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  Workflows will use this CLI for all agent executions. Changing
                  the backend takes effect after saving and restarting the
                  sidecar.
                </small>
              </label>
            </div>
          </SectionCard>
        </div>

        <div className="settings-sticky-bar">
          <div className="settings-sticky-copy">
            <strong>
              {settingsConfigured
                ? "Runtime configuration is complete."
                : "Finish the required settings before the sidecar can boot."}
            </strong>
            {settingsMessage ? (
              <p
                className={
                  settingsMessage.startsWith("Failed") ? "error" : "success"
                }
              >
                {settingsMessage}
              </p>
            ) : (
              <p className="muted">
                Theme changes preview live. Save persists both runtime fields
                and appearance choices to the local database.
              </p>
            )}
          </div>

          <button
            className="primary-button"
            type="submit"
            disabled={savingSettings}
          >
            {savingSettings ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
