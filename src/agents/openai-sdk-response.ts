import type { Model, StreamOptions } from "../llm/types.js";

type OpenAISdkHeaders = {
  forEach(callback: (value: string, key: string) => void): void;
};

type OpenAISdkFinalResponse<T> = {
  data: T;
  response: {
    status: number;
    headers: OpenAISdkHeaders;
  };
};

export type OpenAISdkRequest<T> = {
  withResponse(): Promise<OpenAISdkFinalResponse<T>>;
};

function normalizeOpenAISdkHeaders(headers: OpenAISdkHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function notifyOpenAISdkResponse<T>(params: {
  finalResponse: OpenAISdkFinalResponse<T>;
  model: Model;
  onResponse?: StreamOptions["onResponse"];
}): Promise<T> {
  await params.onResponse?.(
    {
      status: params.finalResponse.response.status,
      headers: normalizeOpenAISdkHeaders(params.finalResponse.response.headers),
    },
    params.model,
  );
  return params.finalResponse.data;
}

export async function withOpenAISdkResponse<T>(
  request: OpenAISdkRequest<T>,
  model: Model,
  onResponse?: StreamOptions["onResponse"],
  fallback?: (error: unknown) => OpenAISdkRequest<T> | undefined,
): Promise<T> {
  let finalResponse: OpenAISdkFinalResponse<T>;
  try {
    finalResponse = await request.withResponse();
  } catch (error) {
    const fallbackRequest = fallback?.(error);
    if (!fallbackRequest) {
      throw error;
    }
    finalResponse = await fallbackRequest.withResponse();
  }
  return await notifyOpenAISdkResponse({ model, onResponse, finalResponse });
}
