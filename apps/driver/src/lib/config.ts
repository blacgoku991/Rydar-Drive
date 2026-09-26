import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

export const appConfig = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL || extra.supabaseUrl || "",
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || extra.supabaseAnonKey || "",
  apiUrl: process.env.EXPO_PUBLIC_API_URL || extra.apiUrl || "",
  easProjectId: (Constants.expoConfig?.extra as any)?.eas?.projectId as string | undefined,
};
