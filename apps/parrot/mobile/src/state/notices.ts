// UX-NOTICE-04 / UX-NOTICE-05: Parrot's notice history on the phone and the TV, one per signed-in user under the
// fleet's key (`sf.notifications.<user>`, as on Badger's phone and TV), with the account's news from any device (another
// sign-in, a payment, storage over its limit) merged in on sign-in and each time the app comes back to the front.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAccountNews } from "@space/mobile-shell/account-news";
import { useAccountNoticeHistory } from "@space/mobile-shell/notice-history";
import { historyStorageKey, type NoticeHistory } from "@space/notify-core/history";
import { useSession } from "./session";

export const useParrotNoticeHistory = (): NoticeHistory | null => {
  const { session } = useSession();
  const history = useAccountNoticeHistory(session ? historyStorageKey(session.user.id) : null, AsyncStorage);
  useAccountNews(history, session?.token);
  return history;
};
