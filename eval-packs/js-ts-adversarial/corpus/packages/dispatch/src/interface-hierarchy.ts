export interface Identified {
  id: string;
}

export interface Timed extends Identified {
  createdAt: number;
}

export interface Audited extends Timed {
  actor: string;
}

export interface Versioned {
  version: number;
}

export class AuditedRecord implements Audited, Versioned {
  constructor(
    public id: string,
    public createdAt: number,
    public actor: string,
    public version: number,
  ) {}
}
