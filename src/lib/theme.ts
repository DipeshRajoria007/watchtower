import type { AppSettings, ThemeFontFamilyId, ThemePresetId } from '../types';

type ThemeFontOption = {
  id: ThemeFontFamilyId;
  label: string;
  note: string;
  stack: string;
};

type ThemePresetDefinition = {
  accentColor: string;
  backgroundColor: string;
  description: string;
  fontFamily: ThemeFontFamilyId;
  foregroundColor: string;
  id: Exclude<ThemePresetId, 'custom'>;
  label: string;
};

type ThemeSettingsShape = Pick<
  AppSettings,
  'themeAccentColor' | 'themeBackgroundColor' | 'themeFontFamily' | 'themeForegroundColor' | 'themePreset'
>;

type RGB = {
  b: number;
  g: number;
  r: number;
};

export type ResolvedAppTheme = {
  accentColor: string;
  backgroundColor: string;
  description: string;
  font: ThemeFontOption;
  foregroundColor: string;
  id: ThemePresetId;
  isCustom: boolean;
  label: string;
};

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DEFAULT_MONO_STACK = '"IBM Plex Mono", "SF Mono", monospace';

export const THEME_FONT_OPTIONS: ThemeFontOption[] = [
  {
    id: 'ibm-plex',
    label: 'IBM Plex Sans',
    note: 'Technical and crisp',
    stack: '"IBM Plex Sans", "Segoe UI", sans-serif',
  },
  {
    id: 'sf-pro',
    label: 'SF Pro',
    note: 'Native macOS feel',
    stack: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  {
    id: 'avenir-next',
    label: 'Avenir Next',
    note: 'Quiet and polished',
    stack: '"Avenir Next", "Helvetica Neue", sans-serif',
  },
  {
    id: 'georgia',
    label: 'Georgia',
    note: 'Editorial serif',
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'menlo',
    label: 'Menlo',
    note: 'Terminal-forward',
    stack: 'Menlo, Monaco, "Courier New", monospace',
  },
];

export const THEME_PRESETS: ThemePresetDefinition[] = [
  {
    id: 'watchtower-midnight',
    label: 'Watchtower Midnight',
    description: 'Cold radar blues with the original control-room darkness.',
    backgroundColor: '#06090C',
    foregroundColor: '#F2F7FB',
    accentColor: '#53D2FF',
    fontFamily: 'ibm-plex',
  },
  {
    id: 'signal-paper',
    label: 'Signal Paper',
    description: 'Warm editorial stock with a sharper, news-desk accent.',
    backgroundColor: '#F5EEDD',
    foregroundColor: '#24180F',
    accentColor: '#D9673B',
    fontFamily: 'georgia',
  },
  {
    id: 'ember-terminal',
    label: 'Ember Terminal',
    description: 'Smoked panels, amber glow, and a more operator-heavy voice.',
    backgroundColor: '#140E0A',
    foregroundColor: '#FFF0E2',
    accentColor: '#FF7A32',
    fontFamily: 'menlo',
  },
  {
    id: 'harbor-mint',
    label: 'Harbor Mint',
    description: 'Sea-glass shadows with a cleaner macOS-native rhythm.',
    backgroundColor: '#081513',
    foregroundColor: '#E9FFF8',
    accentColor: '#33D5B2',
    fontFamily: 'sf-pro',
  },
];

const CUSTOM_THEME_COPY = {
  description: 'Manual background, foreground, accent, and font selection.',
  label: 'Custom',
};

const DEFAULT_THEME = THEME_PRESETS[0];

export function normalizeThemeHex(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toUpperCase() : fallback;
}

export function resolveThemeFont(fontFamily: string | null | undefined): ThemeFontOption {
  return THEME_FONT_OPTIONS.find(option => option.id === fontFamily) ?? THEME_FONT_OPTIONS[0];
}

export function resolveAppTheme(settings: ThemeSettingsShape | null | undefined): ResolvedAppTheme {
  if (!settings) {
    return {
      accentColor: DEFAULT_THEME.accentColor,
      backgroundColor: DEFAULT_THEME.backgroundColor,
      description: DEFAULT_THEME.description,
      font: resolveThemeFont(DEFAULT_THEME.fontFamily),
      foregroundColor: DEFAULT_THEME.foregroundColor,
      id: DEFAULT_THEME.id,
      isCustom: false,
      label: DEFAULT_THEME.label,
    };
  }

  if (settings.themePreset === 'custom') {
    const font = resolveThemeFont(settings.themeFontFamily);

    return {
      accentColor: normalizeThemeHex(settings.themeAccentColor, DEFAULT_THEME.accentColor),
      backgroundColor: normalizeThemeHex(settings.themeBackgroundColor, DEFAULT_THEME.backgroundColor),
      description: CUSTOM_THEME_COPY.description,
      font,
      foregroundColor: normalizeThemeHex(settings.themeForegroundColor, DEFAULT_THEME.foregroundColor),
      id: 'custom',
      isCustom: true,
      label: CUSTOM_THEME_COPY.label,
    };
  }

  const preset = THEME_PRESETS.find(option => option.id === settings.themePreset) ?? DEFAULT_THEME;

  return {
    accentColor: preset.accentColor,
    backgroundColor: preset.backgroundColor,
    description: preset.description,
    font: resolveThemeFont(preset.fontFamily),
    foregroundColor: preset.foregroundColor,
    id: preset.id,
    isCustom: false,
    label: preset.label,
  };
}

export function applyAppTheme(settings: ThemeSettingsShape | null | undefined) {
  if (typeof document === 'undefined') {
    return;
  }

  const theme = resolveAppTheme(settings);
  const vars = getThemeCssVariables(theme);
  const root = document.documentElement;

  Object.entries(vars).forEach(([name, value]) => {
    root.style.setProperty(name, value);
  });
}

function getThemeCssVariables(theme: ResolvedAppTheme): Record<string, string> {
  const bg = hexToRgb(theme.backgroundColor);
  const fg = hexToRgb(theme.foregroundColor);
  const accent = hexToRgb(theme.accentColor);
  const isDarkTheme = relativeLuminance(bg) < 0.42;

  return {
    '--accent': theme.accentColor,
    '--accent-rgb': toRgbTuple(accent),
    '--accent-contrast': relativeLuminance(accent) > 0.58 ? '#0D1418' : '#FFFFFF',
    '--accent-soft': toRgba(accent, 0.16),
    '--bg-canvas': theme.backgroundColor,
    '--bg-input': toRgba(mixColors(bg, fg, isDarkTheme ? 0.06 : 0.1), 0.94),
    '--bg-panel': toRgba(mixColors(bg, fg, isDarkTheme ? 0.12 : 0.05), 0.9),
    '--bg-panel-soft': toRgba(mixColors(bg, fg, isDarkTheme ? 0.14 : 0.06), isDarkTheme ? 0.72 : 0.68),
    '--bg-panel-strong': toRgba(mixColors(bg, fg, isDarkTheme ? 0.18 : 0.09), 0.98),
    '--bg-shell': toRgba(mixColors(bg, fg, isDarkTheme ? 0.08 : 0.02), isDarkTheme ? 0.9 : 0.82),
    '--body-gradient-end': toHex(mixColors(bg, fg, isDarkTheme ? 0.0 : 0.01)),
    '--body-gradient-start': toHex(mixColors(bg, fg, isDarkTheme ? 0.06 : 0.02)),
    '--body-radial-primary': toRgba(accent, isDarkTheme ? 0.12 : 0.14),
    '--body-radial-secondary': toRgba(mixColors(accent, fg, 0.36), isDarkTheme ? 0.07 : 0.08),
    '--brand-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.06 : 0.02), 0.94),
    '--brand-gradient-top': toRgba(mixColors(bg, accent, 0.2), 0.84),
    '--button-gradient-bottom': toRgba(mixColors(accent, bg, isDarkTheme ? 0.18 : 0.08), 0.98),
    '--button-gradient-top': toRgba(mixColors(accent, fg, isDarkTheme ? 0.12 : 0.04), 0.96),
    '--composer-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.12 : 0.02), 0.98),
    '--composer-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.2 : 0.06), 0.96),
    '--console-bg': toRgba(mixColors(bg, accent, isDarkTheme ? 0.08 : 0.02), 0.96),
    '--console-fg': toHex(mixColors(fg, accent, isDarkTheme ? 0.12 : 0.06)),
    '--content-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.02 : 0.0), isDarkTheme ? 0.92 : 0.08),
    '--content-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.12 : 0.02), isDarkTheme ? 0.78 : 0.28),
    '--font-mono': theme.font.id === 'menlo' ? theme.font.stack : DEFAULT_MONO_STACK,
    '--font-sans': theme.font.stack,
    '--line': toRgba(fg, isDarkTheme ? 0.22 : 0.16),
    '--line-strong': toRgba(fg, isDarkTheme ? 0.38 : 0.24),
    '--panel-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.08 : 0.02), 0.96),
    '--panel-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.16 : 0.05), 0.96),
    '--raised-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.1 : 0.03), 0.95),
    '--raised-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.18 : 0.06), 0.95),
    '--selected-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.08 : 0.03), 0.98),
    '--selected-gradient-top': toRgba(mixColors(bg, accent, isDarkTheme ? 0.32 : 0.16), 0.98),
    '--shadow': isDarkTheme ? '0 24px 60px rgba(0, 0, 0, 0.35)' : '0 24px 60px rgba(37, 29, 20, 0.12)',
    '--shell-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.04 : 0.01), 0.98),
    '--shell-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.1 : 0.03), 0.98),
    '--sticky-gradient-bottom': toRgba(mixColors(bg, fg, isDarkTheme ? 0.06 : 0.02), 0.98),
    '--sticky-gradient-top': toRgba(mixColors(bg, fg, isDarkTheme ? 0.14 : 0.04), 0.97),
    '--text-label': toHex(mixColors(bg, fg, isDarkTheme ? 0.68 : 0.56)),
    '--text-muted': toHex(mixColors(bg, fg, isDarkTheme ? 0.56 : 0.46)),
    '--text-soft': toHex(mixColors(bg, fg, isDarkTheme ? 0.8 : 0.72)),
    '--text-strong': theme.foregroundColor,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hexColor: string): RGB {
  const normalized = normalizeThemeHex(hexColor, DEFAULT_THEME.backgroundColor).slice(1);

  return {
    b: Number.parseInt(normalized.slice(4, 6), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    r: Number.parseInt(normalized.slice(0, 2), 16),
  };
}

function mixColors(base: RGB, target: RGB, ratio: number): RGB {
  const amount = Math.max(0, Math.min(1, ratio));

  return {
    b: clamp(base.b + (target.b - base.b) * amount),
    g: clamp(base.g + (target.g - base.g) * amount),
    r: clamp(base.r + (target.r - base.r) * amount),
  };
}

function toHex(rgb: RGB): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

function toRgba(rgb: RGB, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function toRgbTuple(rgb: RGB): string {
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
}

function relativeLuminance(rgb: RGB): number {
  const channels = [rgb.r, rgb.g, rgb.b].map(value => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
