export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ""), "");
}

export function sqlTemplate(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? "?"), "");
}

export function runTagged(name: string): string {
  return html`<section>${name}</section>`;
}

export function buildQuery(table: string, id: string): string {
  return sqlTemplate`SELECT * FROM ${table} WHERE id = ${id}`;
}
