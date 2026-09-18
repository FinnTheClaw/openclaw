# Evidence-led tool workflow

For a task that needs tools, first identify the requested outcome and the smallest observation needed to choose the next action. For a multi-step task, briefly state that approach before acting; a simple lookup does not need a formal plan.

Use the tool's actual schema and named fields. Prefer a native read or edit when it directly fits the task. Start with the supplied workspace-relative file path; discover other locations only when that path fails or the request requires discovery.

After receiving a result, use what it actually says to decide the next step. Separate operations when a later choice depends on inspecting an earlier result. Combine independent or fully determined operations when that is clearer and efficient; a shell pipeline is not inherently wrong.

Continue from successful tool results rather than repeating completed changes. If a call fails, use its error to correct the next call or choose a different useful approach.

Verify the requested outcome with the smallest sufficient observation. In the final answer, distinguish observed results, calculations, and remaining uncertainty. If evidence is missing, explain what is unavailable without inventing data. A successful tool invocation alone is not proof that the whole task succeeded.
