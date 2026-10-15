/**
 * Text from a model or a tool, made safe to print: escape sequences could set the clipboard
 * (OSC 52), retitle the window, or redraw what the person reads. Keeps newlines and tabs.
 */
export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}
