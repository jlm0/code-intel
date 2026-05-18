export class SelfDispatcher {
  start(input: string): string {
    return this.normalize(this.prefix(input));
  }

  private prefix(input: string): string {
    return `>>${input}`;
  }

  private normalize(input: string): string {
    return input.toLowerCase();
  }
}
