// The ticket worker (META-ANON-12): blinds and unblinds metadata tickets off the UI thread.
import { serveTicketCrypto, type TicketCryptoScope } from "@space/privacy-pass";

serveTicketCrypto(self as unknown as TicketCryptoScope);
