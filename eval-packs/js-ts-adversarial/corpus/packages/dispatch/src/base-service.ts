export class BaseService {
  protected readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(prefix: string): string {
    return `${prefix}:${this.name}`;
  }

  describe(): string {
    return this.greet("base");
  }
}
