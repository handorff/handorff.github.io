/** Enhance ordinary page links while keeping the shared background alive. */
export function bindNavigation(options: {
  header: HTMLElement;
  content: HTMLElement;
  overlay: HTMLElement;
  onNavigate: () => void;
}): void {
  const { header, content, overlay, onNavigate } = options;
  const links = [...header.querySelectorAll<HTMLAnchorElement>("nav a")];
  const pagePaths = new Set(links.map((link) => new URL(link.href).pathname));
  const pages = new Map<string, Promise<{ title: string; html: string }>>();
  let navigationId = 0;

  pages.set(window.location.href, Promise.resolve({
    title: document.title,
    html: content.innerHTML
  }));

  const loadPage = (url: URL) => {
    let page = pages.get(url.href);
    if (!page) {
      page = (async () => {
        const response = await fetch(url.href, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Page request failed: ${response.status}`);
        const nextDocument = new DOMParser().parseFromString(await response.text(), "text/html");
        const nextContent = nextDocument.querySelector("#site-content");
        if (!nextContent) throw new Error("Page content is missing");
        return { title: nextDocument.title, html: nextContent.innerHTML };
      })();
      pages.set(url.href, page);
      void page.catch(() => pages.delete(url.href));
    }
    return page;
  };

  const navigate = async (url: URL, push: boolean) => {
    const id = ++navigationId;
    try {
      const page = await loadPage(url);
      // A slower request must never replace a more recent navigation.
      if (id !== navigationId) return;
      if (push && url.href !== window.location.href) {
        window.history.pushState(null, "", url.href);
      }
      content.innerHTML = page.html;
      document.title = page.title;
      for (const link of links) {
        if (new URL(link.href).pathname === url.pathname) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      }
      overlay.scrollTop = 0;
      onNavigate();
      content.focus({ preventScroll: true });
    } catch {
      // Ordinary navigation remains the fallback if fetching a page fails.
      if (id === navigationId) window.location.assign(url.href);
    }
  };

  content.tabIndex = -1;
  for (const link of links) {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          event.defaultPrevented || link.hasAttribute("download") ||
          (link.target && link.target !== "_self")) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin || !pagePaths.has(url.pathname)) return;
      event.preventDefault();
      void navigate(url, true);
    });
  }
  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href);
    if (pagePaths.has(url.pathname)) void navigate(url, false);
  });
}
