import { classifyNsfw as classify } from "@dawgostan/nsfw";
import { env } from "../env.js";

export function classifyNsfw(filePath: string, mediaType: "image" | "video", animated: boolean) {
  return classify(filePath, mediaType, animated, {
    ensembleClassifierUrl: env.NSFW_ENSEMBLE_CLASSIFIER_URL,
    ensembleThreshold: env.NSFW_ENSEMBLE_THRESHOLD,
    maxFrames: env.NSFW_MAX_FRAMES,
  });
}
