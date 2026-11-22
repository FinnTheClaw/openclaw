import { RastermillError, RastermillUnavailableError } from "rastermill";
import { expect, it, vi } from "vitest";
import { normalizeUserBackgroundImage, UserBackgroundInputError } from "./user-background-image.js";

const encode = vi.hoisted(() => vi.fn());

vi.mock("rastermill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("rastermill")>()),
  readImageProbeFromHeader: () => ({ format: "jpeg", width: 1, height: 1 }),
}));
vi.mock("../media/image-ops.js", () => ({ isAnimatedWebpBuffer: vi.fn() }));
vi.mock("../media/image-processor.js", () => ({
  createImageProcessorWithPixelLimits: () => ({ encode }),
}));

it("classifies a typed full-decode refusal but preserves a codec service failure", async () => {
  // Inert transport text: both the header probe and encoder are fakes.
  const transport = "dGVzdA==";
  const serviceFailure = new RastermillUnavailableError("encode", "Codec service unavailable", []);
  encode.mockRejectedValueOnce(serviceFailure);
  await expect(normalizeUserBackgroundImage(transport)).rejects.toBe(serviceFailure);

  const inputFailure = new RastermillError("RASTERMILL_UNDECODABLE", "Image could not be decoded");
  encode.mockRejectedValueOnce(inputFailure);
  await expect(normalizeUserBackgroundImage(transport)).rejects.toBeInstanceOf(
    UserBackgroundInputError,
  );
  expect(encode).toHaveBeenCalledTimes(2);
});
