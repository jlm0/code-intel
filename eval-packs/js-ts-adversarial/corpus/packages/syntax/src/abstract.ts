export abstract class AbstractTransport {
  abstract send(payload: string): Promise<void>;

  protected log(message: string): void {
    console.log(`[transport] ${message}`);
  }
}

export class HttpTransport extends AbstractTransport {
  async send(payload: string): Promise<void> {
    this.log(payload);
  }
}

export class NoopTransport extends AbstractTransport {
  async send(payload: string): Promise<void> {
    void payload;
  }
}
