// Thin wrapper over window.Telegram.WebApp. Everything degrades to no-ops in a plain browser.
const tg = window.Telegram?.WebApp;
export const inTelegram = Boolean(tg?.initData);
export const initData = tg?.initData ?? "";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function setupTelegram() {
  const apply = () => {
    document.documentElement.dataset.theme = tg?.colorScheme === "dark" ? "dark" : "light";
    const bg = css("--color-bg");
    try {
      tg?.setHeaderColor(bg);
      tg?.setBackgroundColor(bg);
      tg?.setBottomBarColor?.(bg);
    } catch {}
  };
  if (!tg) {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return;
  }
  tg.ready();
  tg.expand();
  apply();
  tg.onEvent("themeChanged", apply);
}

// Mapped in 04 Motion → haptics.
export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred("light"),
  select: () => tg?.HapticFeedback?.selectionChanged(),
  warning: () => tg?.HapticFeedback?.notificationOccurred("warning"),
  success: () => tg?.HapticFeedback?.notificationOccurred("success"),
  error: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

export function backButton(onBack) {
  if (!tg?.BackButton) return () => {};
  tg.BackButton.show();
  tg.BackButton.onClick(onBack);
  return () => {
    tg.BackButton.offClick(onBack);
    tg.BackButton.hide();
  };
}

// Unsent text: ask before closing, and don't let a stray swipe close the app.
export function guardTyping(active) {
  if (!tg) return;
  if (active) {
    tg.enableClosingConfirmation?.();
    tg.disableVerticalSwipes?.();
  } else {
    tg.disableClosingConfirmation?.();
    tg.enableVerticalSwipes?.();
  }
}

// Face ID / fingerprint before risky actions. Falls back to a plain confirm where biometrics aren't set up.
export function confirmIdentity(reason) {
  const bio = tg?.BiometricManager;
  if (!bio) return Promise.resolve(true);
  return new Promise((resolve) => {
    const ask = () => {
      if (!bio.isBiometricAvailable) {
        return tg.showConfirm ? tg.showConfirm(reason, (ok) => resolve(ok)) : resolve(true);
      }
      const auth = () => bio.authenticate({ reason }, (ok) => resolve(Boolean(ok)));
      if (bio.isAccessGranted) auth();
      else bio.requestAccess({ reason: "claudia asks before running things on your laptop" }, (granted) => (granted ? auth() : resolve(false)));
    };
    bio.isInited ? ask() : bio.init(ask);
  });
}
