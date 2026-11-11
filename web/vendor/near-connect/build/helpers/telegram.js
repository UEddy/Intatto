"use strict";
// Telegram Mini App bridge. Inside a Mini App the webview blocks window.open
// (the call comes from a postMessage handler, not a user gesture) and never routes custom schemes,
// so links have to go through Telegram itself. The dApp may not load telegram-web-app.js,
// so we fall back to the raw bridge: https://core.telegram.org/api/web-events
Object.defineProperty(exports, "__esModule", { value: true });
exports.openExternalLink = exports.openTelegramLink = exports.isTelegramMiniApp = void 0;
const getWebApp = () => {
    const tgapp = window?.Telegram?.WebApp;
    // Outside of Telegram the SDK still exists but reports "unknown" platform
    if (!tgapp || !tgapp.platform || tgapp.platform === "unknown")
        return null;
    return tgapp;
};
const hasLaunchParams = () => {
    try {
        if (location.hash.includes("tgWebAppData"))
            return true;
        return !!sessionStorage.getItem("__telegram__initParams");
    }
    catch {
        return false;
    }
};
const isTelegramMiniApp = () => {
    if (typeof window === "undefined")
        return false;
    return !!getWebApp() || !!window.TelegramWebviewProxy || hasLaunchParams();
};
exports.isTelegramMiniApp = isTelegramMiniApp;
const postEvent = (eventType, eventData) => {
    const proxy = window.TelegramWebviewProxy;
    if (proxy?.postEvent)
        return proxy.postEvent(eventType, JSON.stringify(eventData)); // iOS, Android
    const external = window.external;
    if (external && "notify" in external)
        return external.notify(JSON.stringify({ eventType, eventData })); // Desktop
    if (window.parent !== window) {
        window.parent.postMessage(JSON.stringify({ eventType, eventData }), "https://web.telegram.org"); // Web
    }
};
const openTelegramLink = (url) => {
    const tgapp = getWebApp();
    if (tgapp)
        return tgapp.openTelegramLink(url.toString());
    postEvent("web_app_open_tg_link", { path_full: url.pathname + url.search });
};
exports.openTelegramLink = openTelegramLink;
const openExternalLink = (url) => {
    const tgapp = getWebApp();
    if (tgapp)
        return tgapp.openLink(url.toString());
    postEvent("web_app_open_link", { url: url.toString() });
};
exports.openExternalLink = openExternalLink;
//# sourceMappingURL=telegram.js.map