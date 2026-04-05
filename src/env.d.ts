declare namespace NodeJS {
  interface ProcessEnv {
    HELIUS_API_KEY: string;
    OPENAI_API_KEY: string;
    OPENAI_BASE_URL: string;
    MODEL_NAME: string;
    OPENAI_SMALL_MODEL: string;
    OPENAI_LARGE_MODEL: string;
    OPENAI_EMBEDDING_URL: string;
    OPENAI_EMBEDDING_API_KEY: string;
    OPENAI_EMBEDDING_MODEL: string;
    OPENAI_EMBEDDING_DIMENSIONS: string;
    SERVER_PORT: string;
  }
}
