export interface MessageContent {
  type: "text" | "image";
  content: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: MessageContent[];
  timestamp: number;
  metadata?: {
    relatedData?: {
      portfolioValue?: number;
      tradeId?: string;
      botId?: string;
      strategyId?: string;
    };
    visualizations?: {
      type: "chart" | "table" | "metric";
      data: any;
    }[];
  };
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  timestamp: number;
  image?: string;
}

export interface KAIConversation {
  id: string;
  messages: ChatMessage[];
  context: {
    viewMode: "personal" | "group";
    selectedGroup?: string;
    activeFilters?: Record<string, any>;
  };
}

export interface KAIPreferences {
  autoSuggestions: boolean;
  dailySummaries: boolean;
  alertNotifications: boolean;
  dataVisualization: boolean;
  voiceInteraction: boolean;
}