export type ThemeMode = "light" | "dark";

interface ThemeState {
  getTheme: () => ThemeMode;
  setDarkModeEnabled: (isDarkModeEnabled: boolean) => ThemeMode;
}

const THEME_ATTRIBUTE = "data-theme";
const LIGHT_GRID_TOKEN = "--grid-line-color-light";
const DARK_GRID_TOKEN = "--grid-line-color-dark";

export function createThemeState(initialTheme: ThemeMode = "light"): ThemeState {
  let theme = initialTheme;

  return {
    getTheme: () => theme,
    setDarkModeEnabled: (isDarkModeEnabled: boolean): ThemeMode => {
      theme = isDarkModeEnabled ? "dark" : "light";
      return theme;
    }
  };
}

export function applyTheme(theme: ThemeMode, body: HTMLElement = document.body): void {
  body.setAttribute(THEME_ATTRIBUTE, theme);
}

export function setContentVisible(content: HTMLElement, visible: boolean): void {
  content.inert = !visible;
  content.setAttribute("aria-hidden", String(!visible));
}

export function setContentLayerVisible(
  content: HTMLElement,
  overlay: HTMLElement,
  visible: boolean
): void {
  setContentVisible(content, visible);
  overlay.setAttribute("data-content-visible", String(visible));
}

export function getThemeGridLineColor(
  theme: ThemeMode,
  root: HTMLElement = document.documentElement
): string {
  const token = theme === "dark" ? DARK_GRID_TOKEN : LIGHT_GRID_TOKEN;
  const color = getComputedStyle(root).getPropertyValue(token).trim();

  if (!color) {
    throw new Error(`Missing required CSS variable: ${token}`);
  }

  return color;
}
