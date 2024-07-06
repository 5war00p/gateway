// Docs for REST API
// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/send-multimodal-prompts#gemini-send-multimodal-samples-drest

import { GOOGLE_VERTEX_AI } from '../../globals';
import { VERTEX_AI } from '../../middlewares/portkey/globals';
import { ContentType, Message, Params } from '../../types/requestBody';
import {
  AnthropicChatCompleteResponse,
  AnthropicChatCompleteStreamResponse,
  AnthropicErrorResponse,
} from '../anthropic/chatComplete';
import {
  ChatCompletionResponse,
  ErrorResponse,
  ProviderConfig,
} from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
} from '../utils';
import { transformGenerationConfig } from './transformGenerationConfig';
import type {
  GoogleErrorResponse,
  GoogleGenerateContentResponse,
} from './types';

export const VertexGoogleChatCompleteConfig: ProviderConfig = {
  // https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versioning#gemini-model-versions
  model: {
    param: 'model',
    required: true,
    default: 'gemini-1.0-pro',
  },
  messages: [
    {
      param: 'contents',
      default: '',
      transform: (params: Params) => {
        let lastRole: 'user' | 'model' | undefined;
        const messages: { role: string; parts: { text: string }[] }[] = [];

        params.messages?.forEach((message: Message) => {
          if (message.role === 'system') return;

          const role = message.role === 'assistant' ? 'model' : 'user';

          let parts = [];
          if (typeof message.content === 'string') {
            parts.push({
              text: message.content,
            });
          }

          if (message.content && typeof message.content === 'object') {
            message.content.forEach((c: ContentType) => {
              if (c.type === 'text') {
                parts.push({
                  text: c.text,
                });
              }
              if (c.type === 'image_url') {
                const { url } = c.image_url || {};

                if (!url) {
                  // Shouldn't throw error?
                  return;
                }

                // Example: data:image/png;base64,abcdefg...
                if (url.startsWith('data:')) {
                  const [mimeTypeWithPrefix, base64Image] =
                    url.split(';base64,');
                  const mimeType = mimeTypeWithPrefix.split(':')[1];

                  parts.push({
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Image,
                    },
                  });

                  return;
                }

                // This part is problematic because URLs are not supported in the current implementation.
                // Two problems exist:
                // 1. Only Google Cloud Storage URLs are supported.
                // 2. MimeType is not supported in OpenAI API, but it is required in Google Vertex AI API.
                // Google will return an error here if any other URL is provided.
                parts.push({
                  fileData: {
                    mimeType: 'image/jpeg',
                    fileUri: url,
                  },
                });
              }
            });
          }

          // @NOTE: This takes care of the "Please ensure that multiturn requests alternate between user and model."
          // error that occurs when we have multiple user messages in a row.
          const shouldAppendEmptyModeChat =
            lastRole === 'user' &&
            role === 'user' &&
            !params.model?.includes('vision');

          if (shouldAppendEmptyModeChat) {
            messages.push({ role: 'model', parts: [{ text: '' }] });
          }

          messages.push({ role, parts });
          lastRole = role;
        });

        return messages;
      },
    },
    {
      param: 'systemInstruction',
      default: '',
      transform: (params: Params) => {
        const firstMessage = params.messages?.[0] || null;
        if (!firstMessage) return;

        if (
          firstMessage.role === 'system' &&
          typeof firstMessage.content === 'string'
        ) {
          return {
            parts: [
              {
                text: firstMessage.content,
              },
            ],
            role: 'system',
          };
        }

        if (
          firstMessage.role === 'system' &&
          typeof firstMessage.content === 'object' &&
          firstMessage.content?.[0]?.text
        ) {
          return {
            parts: [
              {
                text: firstMessage.content?.[0].text,
              },
            ],
            role: 'system',
          };
        }

        return;
      },
    },
  ],
  temperature: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  top_p: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  top_k: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  max_tokens: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  stop: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  response_format: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  // https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/configure-safety-attributes
  // Example payload to be included in the request that sets the safety settings:
  //   "safety_settings": [
  //     {
  //         "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
  //         "threshold": "BLOCK_NONE"
  //     },
  //     {
  //         "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  //         "threshold": "BLOCK_ONLY_HIGH"
  //     }
  // ]
  safety_settings: {
    param: 'safety_settings',
  },
  tools: {
    param: 'tools',
    default: '',
    transform: (params: Params) => {
      const functionDeclarations: any = [];
      params.tools?.forEach((tool) => {
        if (tool.type === 'function') {
          functionDeclarations.push(tool.function);
        }
      });
      return [{ functionDeclarations }];
    },
  },
};

export const VertexAnthropicChatCompleteConfig: ProviderConfig = {
  messages: [
    {
      param: 'messages',
      required: true,
      transform: (params: Params) => {
        let messages: Message[] = [];
        // Transform the chat messages into a simple prompt
        if (!!params.messages) {
          params.messages.forEach((msg) => {
            if (msg.role !== 'system') {
              if (
                msg.content &&
                typeof msg.content === 'object' &&
                msg.content.length
              ) {
                const transformedMessage: Record<string, any> = {
                  role: msg.role,
                  content: [],
                };
                msg.content.forEach((item) => {
                  if (item.type === 'text') {
                    transformedMessage.content.push({
                      type: item.type,
                      text: item.text,
                    });
                  } else if (
                    item.type === 'image_url' &&
                    item.image_url &&
                    item.image_url.url
                  ) {
                    const parts = item.image_url.url.split(';');
                    if (parts.length === 2) {
                      const base64ImageParts = parts[1].split(',');
                      const base64Image = base64ImageParts[1];
                      const mediaTypeParts = parts[0].split(':');
                      if (mediaTypeParts.length === 2 && base64Image) {
                        const mediaType = mediaTypeParts[1];
                        transformedMessage.content.push({
                          type: 'image',
                          source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Image,
                          },
                        });
                      }
                    }
                  }
                });
                messages.push(transformedMessage as Message);
              } else {
                messages.push({
                  role: msg.role,
                  content: msg.content,
                });
              }
            }
          });
        }

        return messages;
      },
    },
    {
      param: 'system',
      required: false,
      transform: (params: Params) => {
        let systemMessage: string = '';
        // Transform the chat messages into a simple prompt
        if (!!params.messages) {
          params.messages.forEach((msg) => {
            if (
              msg.role === 'system' &&
              msg.content &&
              typeof msg.content === 'object' &&
              msg.content[0].text
            ) {
              systemMessage = msg.content[0].text;
            } else if (
              msg.role === 'system' &&
              typeof msg.content === 'string'
            ) {
              systemMessage = msg.content;
            }
          });
        }
        return systemMessage;
      },
    },
  ],
  max_tokens: {
    param: 'max_tokens',
    required: true,
  },
  temperature: {
    param: 'temperature',
    default: 1,
    min: 0,
    max: 1,
  },
  top_p: {
    param: 'top_p',
    default: -1,
    min: -1,
  },
  top_k: {
    param: 'top_k',
    default: -1,
  },
  stop: {
    param: 'stop_sequences',
  },
  stream: {
    param: 'stream',
    default: false,
  },
  user: {
    param: 'metadata.user_id',
  },
  anthropic_version: {
    param: 'anthropic_version',
    required: true,
    default: 'vertex-2023-10-16',
  },
};

export const GoogleChatCompleteResponseTransform: (
  response:
    | GoogleGenerateContentResponse
    | GoogleErrorResponse
    | GoogleErrorResponse[],
  responseStatus: number
) => ChatCompletionResponse | ErrorResponse = (response, responseStatus) => {
  // when error occurs on streaming request, the response is an array of errors.
  if (
    responseStatus !== 200 &&
    Array.isArray(response) &&
    response.length > 0 &&
    'error' in response[0]
  ) {
    const { error } = response[0];

    return generateErrorResponse(
      {
        message: error.message,
        type: error.status,
        param: null,
        code: String(error.code),
      },
      GOOGLE_VERTEX_AI
    );
  }

  if (responseStatus !== 200 && 'error' in response) {
    const { error } = response;
    return generateErrorResponse(
      {
        message: error.message,
        type: error.status,
        param: null,
        code: String(error.code),
      },
      GOOGLE_VERTEX_AI
    );
  }

  if (
    'candidates' in response &&
    response.candidates[0].finishReason === 'PROHIBITED_CONTENT'
  ) {
    return generateInvalidProviderResponseError(response, GOOGLE_VERTEX_AI);
  }

  if ('candidates' in response) {
    const {
      promptTokenCount = 0,
      candidatesTokenCount = 0,
      totalTokenCount = 0,
    } = response.usageMetadata;

    return {
      id: crypto.randomUUID(),
      object: 'chat_completion',
      created: Math.floor(Date.now() / 1000),
      model: 'Unknown',
      provider: GOOGLE_VERTEX_AI,
      choices:
        response.candidates?.map((generation, index) => {
          let message: Message = { role: 'assistant', content: '' };
          if (generation.content.parts[0]?.text) {
            message = {
              role: 'assistant',
              content: generation.content.parts[0]?.text,
            };
          } else if (generation.content.parts[0]?.functionCall) {
            message = {
              role: 'assistant',
              tool_calls: [
                {
                  id: crypto.randomUUID(),
                  type: 'function',
                  function: {
                    name: generation.content.parts[0]?.functionCall.name,
                    arguments: JSON.stringify(
                      generation.content.parts[0]?.functionCall.args
                    ),
                  },
                },
              ],
            };
          }
          return {
            message: message,
            index: index,
            finish_reason: generation.finishReason,
          };
        }) ?? [],
      usage: {
        prompt_tokens: promptTokenCount,
        completion_tokens: candidatesTokenCount,
        total_tokens: totalTokenCount,
      },
    };
  }

  return generateInvalidProviderResponseError(response, GOOGLE_VERTEX_AI);
};

export const GoogleChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string
) => string = (responseChunk, fallbackId) => {
  const chunk = responseChunk
    .trim()
    .replace(/^data: /, '')
    .trim();

  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }

  let parsedChunk: GoogleGenerateContentResponse = JSON.parse(chunk);

  let usageMetadata;
  if (parsedChunk.usageMetadata) {
    usageMetadata = {
      prompt_tokens: parsedChunk.usageMetadata.promptTokenCount,
      completion_tokens: parsedChunk.usageMetadata.candidatesTokenCount,
      total_tokens: parsedChunk.usageMetadata.totalTokenCount,
    };
  }

  const dataChunk = {
    id: fallbackId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: '',
    provider: GOOGLE_VERTEX_AI,
    choices:
      parsedChunk.candidates?.map((generation, index) => {
        let message: Message = { role: 'assistant', content: '' };
        if (generation.content.parts[0]?.text) {
          message = {
            role: 'assistant',
            content: generation.content.parts[0]?.text,
          };
        } else if (generation.content.parts[0]?.functionCall) {
          message = {
            role: 'assistant',
            tool_calls: [
              {
                id: crypto.randomUUID(),
                type: 'function',
                index: 0,
                function: {
                  name: generation.content.parts[0]?.functionCall.name,
                  arguments: JSON.stringify(
                    generation.content.parts[0]?.functionCall.args
                  ),
                },
              },
            ],
          };
        }
        return {
          delta: message,
          index: index,
          finish_reason: generation.finishReason,
        };
      }) ?? [],
    usage: usageMetadata,
  };

  return `data: ${JSON.stringify(dataChunk)}\n\n`;
};

export const AnthropicErrorResponseTransform: (
  response: AnthropicErrorResponse
) => ErrorResponse | undefined = (response) => {
  if ('error' in response) {
    return generateErrorResponse(
      {
        message: response.error?.message,
        type: response.error?.type,
        param: null,
        code: null,
      },
      VERTEX_AI
    );
  }

  return undefined;
};

export const VertexAnthropicChatCompleteResponseTransform: (
  response: AnthropicChatCompleteResponse | AnthropicErrorResponse,
  responseStatus: number
) => ChatCompletionResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200) {
    const errorResposne = AnthropicErrorResponseTransform(
      response as AnthropicErrorResponse
    );
    if (errorResposne) return errorResposne;
  }

  if ('content' in response) {
    const { input_tokens = 0, output_tokens = 0 } = response?.usage;

    return {
      id: response.id,
      object: 'chat_completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      provider: VERTEX_AI,
      choices: [
        {
          message: { role: 'assistant', content: response.content[0].text },
          index: 0,
          logprobs: null,
          finish_reason: response.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: input_tokens,
        completion_tokens: output_tokens,
        total_tokens: input_tokens + output_tokens,
      },
    };
  }

  return generateInvalidProviderResponseError(response, VERTEX_AI);
};

export const VertexAnthropicChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string
) => string | undefined = (responseChunk, fallbackId) => {
  let chunk = responseChunk.trim();

  if (
    chunk.startsWith('event: ping') ||
    chunk.startsWith('event: content_block_start') ||
    chunk.startsWith('event: content_block_stop') ||
    chunk.startsWith('event: vertex_event')
  ) {
    return;
  }

  if (chunk.startsWith('event: message_stop')) {
    return 'data: [DONE]\n\n';
  }

  chunk = chunk.replace(/^event: content_block_delta[\r\n]*/, '');
  chunk = chunk.replace(/^event: message_delta[\r\n]*/, '');
  chunk = chunk.replace(/^event: message_start[\r\n]*/, '');
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();

  const parsedChunk: AnthropicChatCompleteStreamResponse = JSON.parse(chunk);

  if (parsedChunk.type === 'message_start' && parsedChunk.message?.usage) {
    return (
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        provider: VERTEX_AI,
        choices: [
          {
            delta: {
              content: '',
            },
            index: 0,
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: {
          prompt_tokens: parsedChunk.message?.usage?.input_tokens,
        },
      })}` + '\n\n'
    );
  }

  if (parsedChunk.type === 'message_delta' && parsedChunk.usage) {
    return (
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        provider: VERTEX_AI,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: parsedChunk.delta?.stop_reason,
          },
        ],
        usage: {
          completion_tokens: parsedChunk.usage?.output_tokens,
        },
      })}` + '\n\n'
    );
  }

  return (
    `data: ${JSON.stringify({
      id: fallbackId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: '',
      provider: VERTEX_AI,
      choices: [
        {
          delta: {
            content: parsedChunk.delta?.text,
          },
          index: 0,
          logprobs: null,
          finish_reason: parsedChunk.delta?.stop_reason ?? null,
        },
      ],
    })}` + '\n\n'
  );
};
