/** Non-erasable TypeScript input for the isolated worker loading diagnostic. */
enum DiagnosticAnswer {
  Value = 42,
}

/** Fixed imported value; no dependencies or runtime services. */
export const typedValue = DiagnosticAnswer.Value
