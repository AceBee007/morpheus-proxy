export type View = 'dashboard' | 'rules' | 'logs' | 'descriptors' | 'settings';

// URL slugs, appended directly after the admin server's basePath (e.g. /_morpheus/rules).
const VIEW_SLUGS: Record<Exclude<View, 'dashboard'>, string> = {
  rules: 'rules',
  logs: 'logs',
  descriptors: 'grpc-descriptors',
  settings: 'settings',
};

export function parseLocation(pathname: string): { base: string; view: View } {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [view, slug] of Object.entries(VIEW_SLUGS) as Array<[View, string]>) {
    const suffix = `/${slug}`;
    if (trimmed.endsWith(suffix)) {
      const base = trimmed.slice(0, -suffix.length);
      return { base: base === '' ? '/' : base, view };
    }
  }
  return { base: trimmed === '' ? '/' : trimmed, view: 'dashboard' };
}

export function pathFor(base: string, view: View): string {
  const prefix = base === '/' ? '' : base;
  return view === 'dashboard' ? `${prefix}/` : `${prefix}/${VIEW_SLUGS[view]}`;
}
