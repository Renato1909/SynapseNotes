// Tipos de dominio compartilhados entre Worker (D1) e aplicacao web.

export type NoteMode = 'rich' | 'markdown';

export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface PublicUser {
  id: number;
  name: string;
  email: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  mode: NoteMode;
  role: MemberRole;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteMember {
  user: PublicUser;
  role: Exclude<MemberRole, 'owner'>;
  addedAt: string;
}

export interface SessionUser extends PublicUser {
  createdAt: string;
}
