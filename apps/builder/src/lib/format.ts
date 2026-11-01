export const outcomeTone = (o: string | null | undefined) =>
  o === "resolved" || o === "converted"
    ? "success"
    : o === "escalated"
      ? "warning"
      : o === "failed"
        ? "danger"
        : "neutral";
