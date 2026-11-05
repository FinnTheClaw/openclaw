export function prefixMatchPath(pathname: string, prefix: string): boolean {
  if (prefix === "/") {
    return pathname.startsWith("/");
  }
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}
