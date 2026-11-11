"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyText = void 0;
// Clipboard API is missing or rejects in some webviews (Android in-app browsers), execCommand still works there
const copyText = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        return;
    }
    catch { }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
        if (!document.execCommand("copy"))
            throw new Error("Copy failed");
    }
    finally {
        textarea.remove();
    }
};
exports.copyText = copyText;
//# sourceMappingURL=clipboard.js.map