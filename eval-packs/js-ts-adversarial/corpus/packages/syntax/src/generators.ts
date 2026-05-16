export function* fibonacci(limit: number): Generator<number, void, void> {
  let previous = 0;
  let current = 1;
  while (previous < limit) {
    yield previous;
    [previous, current] = [current, previous + current];
  }
}

export async function* streamLines(source: AsyncIterable<string>): AsyncGenerator<string, void, void> {
  for await (const chunk of source) {
    for (const line of chunk.split("\n")) {
      yield line;
    }
  }
}

export function* delegatingGenerator(limit: number): Generator<number, void, void> {
  yield* fibonacci(limit);
}
