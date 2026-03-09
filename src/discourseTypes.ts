export interface TopicPoster {
  description?: string;
  extras?: string;
  primary_group_name?: string;
  user_id?: number;
}

export interface TopicSummary {
  id: number;
  title: string;
  slug?: string;
  created_at?: string;
  bumped_at?: string;
  last_posted_at?: string;
  posts_count?: number;
  reply_count?: number;
  views?: number;
  like_count?: number;
  archetype?: string;
  excerpt?: string;
  category_id?: number;
  posters?: TopicPoster[];
  tags?: string[];
}

export interface LatestTopicsResponse {
  topic_list?: {
    topics?: TopicSummary[];
  };
}

export interface CategorySummary {
  id: number;
  name: string;
  slug: string;
  topic_count?: number;
  post_count?: number;
  color?: string;
  text_color?: string;
  description_text?: string;
}

export interface CategoriesResponse {
  category_list?: {
    categories?: CategorySummary[];
  };
}

export interface PostSummary {
  id: number;
  name?: string;
  username: string;
  avatar_template?: string;
  created_at?: string;
  cooked?: string;
  raw?: string;
  post_number: number;
  reply_to_post_number?: number | null;
  reply_count?: number;
  reads?: number;
  score?: number;
  yours?: boolean;
}

export interface TopicDetails {
  id: number;
  title: string;
  slug?: string;
  fancy_title?: string;
  posts_count?: number;
  reply_count?: number;
  views?: number;
  last_posted_at?: string;
  created_at?: string;
  details?: {
    can_create_post?: boolean;
    participants?: Array<{
      id?: number;
      username?: string;
      name?: string;
      avatar_template?: string;
    }>;
  };
  post_stream?: {
    posts?: PostSummary[];
  };
}

export interface NotificationItem {
  id: number;
  notification_type?: number;
  read?: boolean;
  created_at?: string;
  fancy_title?: string;
  slug?: string;
  topic_id?: number;
  post_number?: number;
  data?: {
    badge_name?: string;
    display_username?: string;
    original_post_id?: number;
    original_post_type?: number;
    topic_title?: string;
    message?: string;
  };
}

export interface NotificationsResponse {
  notifications?: NotificationItem[];
  total_rows_notifications?: number;
  seen_notification_id?: number;
  load_more_notifications?: string;
}

export interface SessionCurrentUser {
  id?: number;
  username?: string;
  name?: string;
  avatar_template?: string;
  trust_level?: number;
}

export interface SessionCurrentResponse {
  current_user?: SessionCurrentUser | null;
  unread_notifications?: number;
  unread_high_priority_notifications?: number;
  unread_private_messages?: number;
}

export interface ConnectionCapabilities {
  canReadSession: boolean;
  canReadNotifications: boolean;
  canReply: boolean;
}

export interface ConnectionConfig {
  baseUrl: string;
  authMode: 'none' | 'userApiKey' | 'cookie' | 'oidc';
  userApiKey?: string;
  userApiClientId?: string;
  username?: string;
  email?: string;
  cookie?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcAccessToken?: string;
  oidcRefreshToken?: string;
  oidcIdToken?: string;
  oidcTokenType?: string;
  oidcScope?: string;
  oidcExpiresAt?: number;
  oidcForumApiEnabled?: boolean;
}

export interface TopicReplyPayload {
  topicId: number;
  raw: string;
  replyToPostNumber?: number;
}

export interface AppState {
  connection: {
    baseUrl: string;
    authMode: ConnectionConfig['authMode'];
    configured: boolean;
    username?: string;
    capabilities: ConnectionCapabilities;
  };
  session?: SessionCurrentResponse;
  latestTopics: TopicSummary[];
  categories: CategorySummary[];
  selectedCategorySlug?: string;
  selectedCategoryId?: number;
  selectedCategoryName?: string;
  categoryTopics: TopicSummary[];
  activeTopic?: TopicDetails;
  notifications: NotificationItem[];
  loading: boolean;
  error?: string;
}

export const EMPTY_CONNECTION_CAPABILITIES: ConnectionCapabilities = {
  canReadSession: false,
  canReadNotifications: false,
  canReply: false,
};

export function getConnectionCapabilities(connection: ConnectionConfig): ConnectionCapabilities {
  if (connection.authMode === 'cookie' && connection.cookie?.trim()) {
    return {
      canReadSession: true,
      canReadNotifications: true,
      canReply: true,
    };
  }

  if (connection.authMode === 'userApiKey' && connection.userApiKey?.trim()) {
    return {
      canReadSession: true,
      canReadNotifications: true,
      canReply: true,
    };
  }

  if (connection.authMode === 'oidc' && connection.oidcAccessToken?.trim() && connection.oidcForumApiEnabled) {
    return {
      canReadSession: true,
      canReadNotifications: true,
      canReply: true,
    };
  }

  return EMPTY_CONNECTION_CAPABILITIES;
}
