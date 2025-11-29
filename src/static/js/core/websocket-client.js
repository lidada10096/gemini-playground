import { EventEmitter } from 'https://cdn.skypack.dev/eventemitter3';
import { blobToJSON, base64ToArrayBuffer } from '../utils/utils.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { ToolManager } from '../tools/tool-manager.js';

/**
 * Client for interacting with the Gemini 2.0 Flash Multimodal Live API via WebSockets.
 * This class handles the connection, sending and receiving messages, and processing responses.
 * It extends EventEmitter to emit events for various stages of the interaction.
 *
 * @extends EventEmitter
 */
export class MultimodalLiveClient extends EventEmitter {
    /**
     * Creates a new MultimodalLiveClient.
     *
     * @param {Object} options - Configuration options.
     * @param {string} [options.url] - The WebSocket URL for the Gemini API. Defaults to a URL constructed with the provided API key.
     */
    constructor() {
        super();
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.baseUrl  = `${wsProtocol}//${window.location.host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
        this.apiBaseUrl = `${window.location.protocol}//${window.location.host}`;
        this.ws = null;
        this.config = null;
        this.send = this.send.bind(this);
        this.toolManager = new ToolManager();
    }

    /**
     * Logs a message with a timestamp and type. Emits a 'log' event.
     *
     * @param {string} type - The type of the log message (e.g., 'server.send', 'client.close').
     * @param {string|Object} message - The message to log.
     */
    log(type, message) {
        this.emit('log', { date: new Date(), type, message });
    }

    /**
     * Initializes the client with the given configuration.
     * Since we're no longer using WebSocket, this method just stores the configuration.
     *
     * @param {Object} config - The configuration for the client.
     * @param {string} config.model - The model to use (e.g., 'gemini-2.0-flash-exp').
     * @param {Object} config.generationConfig - Configuration for content generation.
     * @param {string[]} config.generationConfig.responseModalities - The modalities for the response (e.g., "audio", "text").
     * @param {Object} config.generationConfig.speechConfig - Configuration for speech generation.
     * @param {Object} config.generationConfig.speechConfig.voiceConfig - Configuration for the voice.
     * @param {string} config.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName - The name of the prebuilt voice to use.
     * @param {Object} config.systemInstruction - Instructions for the system.
     * @param {Object[]} config.systemInstruction.parts - Parts of the system instruction.
     * @param {string} config.systemInstruction.parts[].text - Text content of the instruction part.
     * @param {Object[]} [config.tools] - Additional tools to be used by the model.
     * @returns {Promise<boolean>} - Resolves with true when initialized.
     */
    connect(config, apiKey) {
        this.config = {
            ...config,
            tools: [
                ...this.toolManager.getToolDeclarations(),
                ...(config.tools || [])
            ]
        };
        this.apiKey = apiKey;
        
        // 模拟连接成功
        this.log('client.open', 'Connected to socket');
        this.emit('open');
        
        return Promise.resolve(true);
    }

    /**
     * Disconnects the client.
     * Since we're no longer using WebSocket, this method just resets the state.
     *
     * @returns {boolean} - True if disconnected, false otherwise.
     */
    disconnect() {
        this.config = null;
        this.apiKey = null;
        this.log('client.close', 'Disconnected');
        this.emit('close', { code: 0, reason: 'Client disconnected' });
        return true;
    }

    /**
     * Receives and processes a message from the WebSocket server.
     * Handles different types of responses like tool calls, setup completion, and server content.
     *
     * @param {Blob} blob - The received blob data.
     */
    async receive(blob) {
        const response = await blobToJSON(blob);
        if (response.toolCall) {
            this.log('server.toolCall', response);
            await this.handleToolCall(response.toolCall);
            return;
        }
        if (response.toolCallCancellation) {
            this.log('receive.toolCallCancellation', response);
            this.emit('toolcallcancellation', response.toolCallCancellation);
            return;
        }
        if (response.setupComplete) {
            this.log('server.send', 'setupComplete');
            this.emit('setupcomplete');
            return;
        }
        if (response.serverContent) {
            const { serverContent } = response;
            if (serverContent.interrupted) {
                this.log('receive.serverContent', 'interrupted');
                this.emit('interrupted');
                return;
            }
            if (serverContent.turnComplete) {
                this.log('server.send', 'turnComplete');
                this.emit('turncomplete');
            }
            if (serverContent.modelTurn) {
                let parts = serverContent.modelTurn.parts;
                const audioParts = parts.filter((p) => p.inlineData && p.inlineData.mimeType.startsWith('audio/pcm'));
                const base64s = audioParts.map((p) => p.inlineData?.data);
                const otherParts = parts.filter((p) => !audioParts.includes(p));

                base64s.forEach((b64) => {
                    if (b64) {
                        const data = base64ToArrayBuffer(b64);
                        this.emit('audio', data);
                        //this.log(`server.audio`, `buffer (${data.byteLength})`);
                    }
                });

                if (!otherParts.length) {
                    return;
                }

                parts = otherParts;
                const content = { modelTurn: { parts } };
                this.emit('content', content);
                this.log(`server.content`, response);
            }
        } else {
            console.log('Received unmatched message', response);
        }
    }

    /**
     * Sends real-time input data to the server.
     * Since we're no longer using WebSocket, this method is a no-op for now.
     *
     * @param {Array} chunks - An array of media chunks to send. Each chunk should have a mimeType and data.
     */
    sendRealtimeInput(chunks) {
        let hasAudio = false;
        let hasVideo = false;
        let totalSize = 0;

        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            totalSize += ch.data.length;
            if (ch.mimeType.includes('audio')) {
                hasAudio = true;
            }
            if (ch.mimeType.includes('image')) {
                hasVideo = true;
            }
        }

        const message = hasAudio && hasVideo ? 'audio + video' : hasAudio ? 'audio' : hasVideo ? 'video' : 'unknown';
        Logger.debug(`Sending realtime input: ${message} (${Math.round(totalSize/1024)}KB)`);

        // 暂时不支持实时输入
        console.warn('Realtime input is not supported with REST API');
    }

    /**
     * Sends a tool response to the server.
     * Since we're no longer using WebSocket, this method is a no-op for now.
     *
     * @param {Object} toolResponse - The tool response to send.
     */
    sendToolResponse(toolResponse) {
        const message = { toolResponse };
        // 暂时不支持工具响应
        console.warn('Tool response is not supported with REST API');
        this.log(`client.toolResponse`, message);
    }

    /**
     * Sends a message to the server using REST API.
     *
     * @param {string|Object|Array} parts - The message parts to send. Can be a string, an object, or an array of strings/objects.
     * @param {boolean} [turnComplete=true] - Indicates if this message completes the current turn.
     */
    async send(parts, turnComplete = true) {
        parts = Array.isArray(parts) ? parts : [parts];
        const formattedParts = parts.map(part => {
            if (typeof part === 'string') {
                return { text: part };
            } else if (typeof part === 'object' && !part.text && !part.inlineData) {
                return { text: JSON.stringify(part) };
            }
            return part;
        });
        // 提取文本内容，转换为OpenAI格式
        const textContent = formattedParts.map(part => part.text).join(' ');
        
        try {
            // 使用REST API发送消息，确保使用OpenAI格式
            const apiUrl = `${this.apiBaseUrl}/v1/chat/completions`;
            console.log('Sending request to:', apiUrl);
            console.log('Request headers:', {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey.substring(0, 10)}...`
            });
            
            const openAiMessages = [
                {
                    role: 'system',
                    content: this.config.systemInstruction.parts[0].text
                },
                {
                    role: 'user',
                    content: textContent
                }
            ];
            
            console.log('Request body:', JSON.stringify({
                model: this.config.model,
                messages: openAiMessages,
                stream: true
            }));
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.config.model,
                    messages: openAiMessages,
                    stream: true
                })
            });
            
            console.log('Response status:', response.status);
            console.log('Response headers:', response.headers);
            
            if (response.ok) {
                console.log('Response is ok, handling streaming...');
                // 处理流式响应
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        console.log('Streaming done');
                        break;
                    }
                    
                    const chunk = decoder.decode(value, { stream: true });
                    console.log('Received chunk:', chunk);
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            console.log('Received SSE data:', data);
                            if (data === '[DONE]') continue;
                            
                            try {
                                const json = JSON.parse(data);
                                console.log('Parsed SSE data:', json);
                                if (json.choices && json.choices[0].delta.content) {
                                    console.log('Emitting content:', json.choices[0].delta.content);
                                    this.emit('content', {
                                        modelTurn: {
                                            parts: [{ text: json.choices[0].delta.content }]
                                        }
                                    });
                                }
                            } catch (error) {
                                console.error('Error parsing SSE data:', error);
                                console.error('Raw SSE data:', data);
                            }
                        }
                    }
                }
            } else {
                console.log('Response not ok, handling error...');
                try {
                    const error = await response.json();
                    console.error('API Error:', error);
                    this.emit('error', new Error(error.error?.message || 'Failed to send message'));
                } catch (parseError) {
                    const text = await response.text();
                    console.error('Error parsing error response:', parseError);
                    console.error('Raw error response:', text);
                    this.emit('error', new Error(`Failed to send message: ${response.status} ${text}`));
                }
            }
        } catch (error) {
            console.error('Fetch error:', error);
            this.emit('error', error);
        }
        
        this.log(`client.send`, { content });
    }

    /**
     * Sends real-time input data to the server.
     * Since we're no longer using WebSocket, this method is a no-op for now.
     *
     * @param {Array} chunks - An array of media chunks to send. Each chunk should have a mimeType and data.
     */
    sendRealtimeInput(chunks) {
        // 暂时不支持实时输入，因为我们已经切换到REST API
        console.warn('Realtime input is not supported with REST API');
    }

    /**
     * Handles a tool call from the server.
     *
     * @param {Object} toolCall - The tool call data.
     */
    async handleToolCall(toolCall) {
        try {
            const response = await this.toolManager.handleToolCall(toolCall.functionCalls[0]);
            this.sendToolResponse(response);
        } catch (error) {
            Logger.error('Tool call failed', error);
            this.sendToolResponse({
                functionResponses: [{
                    response: { error: error.message },
                    id: toolCall.functionCalls[0].id
                }]
            });
        }
    }
} 