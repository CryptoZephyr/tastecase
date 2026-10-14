import type { ReactElement } from 'react';

export interface DocContent {
  headings: { id: string; label: string }[];
  keywords?: string[];
  Body: () => ReactElement;
}

export type DocSection = Record<string, DocContent>;
