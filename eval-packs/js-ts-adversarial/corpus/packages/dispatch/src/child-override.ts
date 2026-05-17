import { BaseService } from "./base-service";

export class ChildService extends BaseService {
  constructor() {
    super("child");
  }

  override greet(prefix: string): string {
    const fromBase = super.greet(prefix);
    return `${fromBase}!`;
  }
}
