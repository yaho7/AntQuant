/**
 * Copy text. `navigator.clipboard` only exists on HTTPS or localhost, and a
 * self-hosted AntQuant is often opened over plain HTTP on the LAN, so fall back
 * to a hidden textarea. Inside a modal the textarea goes in the dialog, where
 * the focus trap allows selecting it.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = previous?.closest("[role=dialog]") ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  host.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus();
  return ok;
}
