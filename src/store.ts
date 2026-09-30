import fs from "node:fs";
import path from "node:path";
import type { User } from "./types.ts";

// Prototype persistence: one JSON file. Swap for Postgres before real users.
export interface Store {
  getUser(phone: string): User | undefined;
  saveUser(user: User): void;
  allUsers(): User[];
  deleteUser(phone: string): void;
}

export class MemoryStore implements Store {
  protected users = new Map<string, User>();
  getUser(phone: string) {
    return this.users.get(phone);
  }
  saveUser(user: User) {
    this.users.set(user.phone, user);
  }
  allUsers() {
    return [...this.users.values()];
  }
  deleteUser(phone: string) {
    this.users.delete(phone);
  }
}

export class JsonFileStore extends MemoryStore {
  constructor(private file: string) {
    super();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as User[];
      for (const u of data) this.users.set(u.phone, u);
    }
  }
  override saveUser(user: User) {
    super.saveUser(user);
    this.flush();
  }
  override deleteUser(phone: string) {
    super.deleteUser(phone);
    this.flush();
  }
  private flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.allUsers(), null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export function newUser(phone: string): User {
  return {
    phone,
    stage: "age_gate",
    createdAt: new Date().toISOString(),
    matchmakerHistory: [],
    discoveryMessageCount: 0,
    relationships: {},
    chatIds: {},
  };
}
