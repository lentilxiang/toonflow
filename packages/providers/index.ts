/// <reference path="./types.d.ts" />

import tfRouterLanguage from "./src/language/tfRouter";
import deepSeek from "./src/language/deepSeek";
import tfRouterMedia from "./src/media/tfRouter";
import apiMart from "./src/media/apiMart";
import meta from "./src/media/meta";
import agnes from "./src/media/agnes";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [tfRouterLanguage, deepSeek] as const;
export const mediaProviders = [tfRouterMedia, apiMart, meta, agnes] as const;
