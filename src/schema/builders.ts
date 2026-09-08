export type MgColumnType = "jsonb" | "text" | "int" | "float" | "boolean" | "uuid" | "timestamptz" | "vector" | "text[]" | "int[]";

export interface MgColumnDefinition {
  name: string;
  type: MgColumnType;
  nullable?: boolean;
  primaryKey?: boolean;
  default?: string;
  references?: string;
  unique?: boolean;
  check?: string;
}

export interface MgTableDefinition {
  name: string;
  description: string;
  columns: MgColumnDefinition[];
  constraints?: string[];
}

export interface MgIndexDefinition {
  name: string;
  table: string;
  description: string;
}

export interface MgExtensionDefinition {
  name: string;
  description: string;
}

export type MigrationItemStatus = "created" | "exists" | "ensured";

export interface MigrationReportItem {
  name: string;
  status: MigrationItemStatus;
}

export interface MigrationReport {
  extensions: MigrationReportItem[];
  tables: MigrationReportItem[];
  indexes: MigrationReportItem[];
}

export function mgTable(definition: MgTableDefinition): MgTableDefinition {
  return definition;
}

export function mgIndex(definition: MgIndexDefinition): MgIndexDefinition {
  return definition;
}

export function mgExtension(definition: MgExtensionDefinition): MgExtensionDefinition {
  return definition;
}
