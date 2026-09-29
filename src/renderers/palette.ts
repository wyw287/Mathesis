export const CURVE_COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
];

export const colorAt = (i: number, override?: string) => override ?? CURVE_COLORS[i % CURVE_COLORS.length];
