import { ChildService } from "./child-override";

export function describeChild(): string {
  const child = new ChildService();
  return child.describe();
}
