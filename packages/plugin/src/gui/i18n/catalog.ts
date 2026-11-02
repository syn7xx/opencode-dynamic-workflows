/**
 * The Workflows GUI plugin's i18n catalog: every locale inline, keyed by its short locale code (the code the host's
 * `desktop-native` list uses — `zh`, `zht`, `ru` — not the BCP-47 tag `ctx.locale.locale()` returns for `Intl`).
 *
 * English (`./en.ts`) is the source and the fallback: the host merges it under each locale key by key, so a locale
 * may translate part of the catalog and fall through to English for the rest. A test (`test/gui/bundle.test.ts`)
 * checks that every listed locale covers every English key, so a catalog cannot drift silently.
 */
import br from "./br"
import de from "./de"
import en from "./en"
import es from "./es"
import fr from "./fr"
import it from "./it"
import ja from "./ja"
import ko from "./ko"
import nl from "./nl"
import pl from "./pl"
import ru from "./ru"
import tr from "./tr"
import uk from "./uk"
import zh from "./zh"
import zht from "./zht"

export const catalog = {
  en,
  ru,
  uk,
  pl,
  de,
  es,
  fr,
  it,
  nl,
  br,
  tr,
  ja,
  ko,
  zh,
  zht,
} as const
