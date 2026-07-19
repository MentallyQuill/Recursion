export async function runWithRetainedTrace(
  context,
  tracePath,
  work,
  traceOptions = { screenshots: true, snapshots: true }
) {
  let result;
  let primaryError = null;
  let tracingStarted = false;
  try {
    await context.tracing.start(traceOptions);
    tracingStarted = true;
    result = await work();
  } catch (error) {
    primaryError = error;
  } finally {
    if (tracingStarted) {
      try {
        await context.tracing.stop({ path: tracePath });
      } catch (error) {
        primaryError ||= error;
      }
    }
    try {
      await context.close();
    } catch (error) {
      primaryError ||= error;
    }
  }
  if (primaryError) throw primaryError;
  return result;
}
