export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface BaseExecutorEntity {
  id: number;
  created_at: Date;
  updated_at?: Date;
}

export type CamelToSnakeCase<S extends string> = S extends `${infer T}${infer U}` ?
  `${T extends Capitalize<T> ? "_" : ""}${Lowercase<T>}${CamelToSnakeCase<U>}` :
  S;

export type DateToTimestamp<T> = T extends Date ? number : T;
export type TimestampToDate<T> = T extends number ? Date : T;