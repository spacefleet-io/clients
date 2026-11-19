/**
 * One screen of the phone setup walkthrough (UX-SETUP-02, UX-SETUP-08): the app's mascot over a frosted card that
 * starts with "STEP N OF M" and a segmented step bar, then the question and its answers or form, and pill Back and
 * Next buttons under the card; the language button alone at the screen's top right. No "‹ Back" link on top: the pill
 * under the card is the screen's Back (Chris 2026-11-18). Transparent: the app's sky shows through (UX-SKY-02). Takes
 * the app's colours from the shell theme (Badger amber, Parrot green).
 */
import React, { useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingForm } from "../keyboard";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation, type MobileUiLanguage } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileLanguageMenu } from "./mobile-language-menu";

/** Fill of a step bar segment not reached yet. */
const SEGMENT_OFF = "#ffffff1f";

/**
 * The header of every setup screen: "STEP N OF M", the language button in the top-right corner, and a bar of one
 * segment per step, those reached in the app's colour; a setup step draws each part where `SetupHeaderPart` says (the
 * phone: the count and bar inside the card). It has no Back: every setup screen's one Back is a pill at its bottom,
 * beside Next or, on a sign-in, alone (`MobileSetupBackFooter`, UX-SETUP-08). Step 0 (the language and the sign-in,
 * before the numbered steps, UX-SETUP-08) shows no count. The language button stays in that corner for the whole setup (UX-SETUP-08): `onLanguage` switches
 * the app's language; the sign-in screens leave it out since their own corner already holds one.
 */
/**
 * Which part of the header a setup screen draws where. TV (UX-TV-33, UX-SETUP-08): the step's card holds "STEP N OF M"
 * at its top left, above the title, with the bar under it (`steps`, the approved `tv-step.png`); the language button
 * sits alone at the screen's top right (`language`). Phone (UX-SETUP-08, the approved design): the screen's top holds
 * the language button, and Back when the screen has no pill (`phoneTop`); the card's top-left holds "STEP N OF M" with
 * the bar under it, above the title, as on the computer (`phoneCard`). A header drawn outside a setup step (the
 * sign-in screens) draws it all at once (`all`). `scale`: a TV screen drawn at its own TV scale (Apple TV) sizes the
 * count and the bar with it.
 */
const SetupHeaderPart = React.createContext<{ part: "all" | "steps" | "language" | "phoneTop" | "phoneCard"; scale: number }>({ part: "all", scale: 1 });
const PHONE_TOP = { part: "phoneTop", scale: 1 } as const;
const PHONE_CARD = { part: "phoneCard", scale: 1 } as const;

/** A TV setup screen of its own (not `MobileSetupStep`) places the header's parts: `steps` in its card, `language` in its corner. */
export const MobileSetupTvHeaderPart = ({ part, scale = 1, children }: { part: "steps" | "language"; scale?: number; children: ReactNode }) => (
  <SetupHeaderPart.Provider value={{ part, scale }}>{children}</SetupHeaderPart.Provider>
);

/**
 * Phone: scrolls a setup step to its end, so a choice menu that opened at the card's bottom (the language step's) is in
 * view whole on a short phone (360x640dp), its rows never cut off below the screen (UX-SETUP-08).
 */
const SetupRevealEnd = React.createContext<(() => void) | null>(null);

/**
 * The setup's count, bar and language button. It has no "‹ Back": every phone setup screen's Back is the pill at its
 * bottom (`MobileSetupStep`'s footer, `MobileSetupBackFooter` on the sign-in), the TV's the card's own pill
 * (UX-SETUP-08, Chris 2026-11-18: "drop the top left one when there's already one at the bottom").
 */
export const MobileSetupHeader = ({
  step,
  total,
  onLanguage,
}: {
  step: number;
  total: number;
  onLanguage?: (code: MobileUiLanguage) => void;
}) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const { part, scale } = useContext(SetupHeaderPart);
  const counted = step > 0;
  const language = onLanguage ? (
    <View testID="setup-language-menu">
      <MobileLanguageMenu
        current={getCurrentLanguage()}
        languages={MOBILE_UI_LANGUAGES}
        onSelect={(code) => {
          if (isMobileUiLanguage(code)) onLanguage(code);
        }}
      />
    </View>
  ) : null;
  if (part === "language") return language;
  if (part === "steps") {
    // TV: Back is the card's own pill, so the card's top is the count and the bar only.
    if (!counted) return null;
    return (
      <View style={{ gap: 8 * scale }} testID="setup-step-bar">
        <Text
          testID="setup-step-indicator"
          style={[styles.eyebrowTv, { color: theme.colors.accent, fontSize: 11 * scale, letterSpacing: 1.44 * scale }]}
        >
          {t("setup.stepOf", { step, total }).toUpperCase()}
        </Text>
        <View style={[styles.segmentsTv, { gap: 4 * scale }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {Array.from({ length: total }, (_, index) => (
            <View
              key={index}
              style={[styles.segmentTv, { height: 3 * scale, borderRadius: 1.5 * scale, backgroundColor: index < step ? theme.colors.accent : theme.colors.surfaceRaised }]}
            />
          ))}
        </View>
      </View>
    );
  }
  const count = counted ? (
    <Text testID="setup-step-indicator" style={[styles.eyebrow, { color: theme.colors.textMuted }]}>
      {t("setup.stepOf", { step, total }).toUpperCase()}
    </Text>
  ) : null;
  const bar = counted ? (
    <View style={styles.segments} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, index) => (
        <View key={index} style={[styles.segment, { backgroundColor: index < step ? theme.colors.accent : SEGMENT_OFF }]} />
      ))}
    </View>
  ) : null;
  if (part === "phoneTop") {
    if (!language) return null;
    return (
      <View style={styles.headerRow} testID="setup-top">
        <View />
        {language}
      </View>
    );
  }
  if (part === "phoneCard") {
    if (!counted) return null;
    return (
      <View style={styles.cardSteps} testID="setup-step-bar">
        {count}
        {bar}
      </View>
    );
  }
  return (
    <View style={{ gap: 10 }} testID="setup-step-bar">
      <View style={styles.headerRow}>
        <View />
        <View style={styles.headerEnd}>
          {count}
          {language}
        </View>
      </View>
      {bar}
    </View>
  );
};

/** The phone's mascot over the setup card, in dp. */
const MASCOT_SIZE = 84;
/** How far the mascot reaches down over the card's top border: the phone's 26 dp of 84, about half the badger's body. */
export const setupMascotOverlap = (size: number) => (size * 26) / MASCOT_SIZE;
/**
 * TV (UX-SETUP-08, Chris 2026-11-18): the mascot over every TV setup card, in TV design dp (960x540: twice that in pixels
 * on a 1080p TV). A TV screen drawn at its own TV scale multiplies it by that scale.
 */
export const TV_SETUP_MASCOT_SIZE = 80;
/** TV: the top padding of a setup card under the mascot, in TV design dp: the overlap and a gap before the card's text. */
export const TV_SETUP_CARD_TOP = setupMascotOverlap(TV_SETUP_MASCOT_SIZE) + 12;
/** TV: the same in the shared setup step (the key step), whose 12 boxes need the room: a closer gap under the mascot. */
const TV_STEP_CARD_TOP = setupMascotOverlap(TV_SETUP_MASCOT_SIZE) + 6;

/**
 * The app's mascot floating over the setup card's top border, with a soft glow in the app's colour behind it (the
 * phone at 84 dp; a TV passes its own size). Placed right above the card: it reaches `setupMascotOverlap(size)` down
 * over the card, whose top padding keeps the card's text below it.
 */
export const MobileSetupMascot = ({ size = MASCOT_SIZE, testID }: { size?: number; testID?: string }) => {
  const theme = useMobileShellTheme();
  const glow = (size * 72) / MASCOT_SIZE;
  return (
    <View
      style={[styles.mascotWrap, { width: (size * 96) / MASCOT_SIZE, height: size, marginBottom: -setupMascotOverlap(size) }]}
      pointerEvents="none"
      testID={testID ?? "setup-mascot"}
    >
      <View style={[styles.mascotGlow, { width: glow, height: glow, borderRadius: glow / 2, backgroundColor: theme.colors.accent }]} />
      <Image source={theme.mascotSource} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />
    </View>
  );
};

/** The frosted card of a setup screen: `top` (the step count and bar), the title in the display face, optional body, then the step's content. */
export const MobileSetupCard = ({
  title,
  body,
  children,
  mascot = true,
  top,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
  /** The mascot overlaps the card's top; without it the card's top padding is its usual one. */
  mascot?: boolean;
  /** Drawn at the card's top-left, above the title: the phone's "STEP N OF M" and step bar (UX-SETUP-08). */
  top?: React.ReactNode;
}) => {
  const theme = useMobileShellTheme();
  return (
    <View
      testID="setup-card"
      style={[
        styles.card,
        { backgroundColor: `${theme.colors.surface}c7`, borderColor: theme.colors.border, padding: theme.spacing.lg, gap: theme.spacing.md },
        !mascot && { paddingTop: theme.spacing.lg },
      ]}
    >
      {top}
      <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display }]}>
        {title}
      </Text>
      {body ? <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.size.md, lineHeight: 21 }}>{body}</Text> : null}
      {children}
    </View>
  );
};

/**
 * A footer pill. The remote's ring (UX-TV-17) is drawn over it while it has the focus, in the text colour, so focusing
 * never shifts the footer; a touch screen never focuses it, so the phone's look is unchanged.
 */
const SetupPill = ({
  children,
  style,
  preferredFocus,
  ...pressable
}: React.ComponentProps<typeof Pressable> & { children: React.ReactNode; preferredFocus?: boolean }) => {
  const theme = useMobileShellTheme();
  const [focused, setFocused] = useState(false);
  const tv = Platform.isTV === true;
  return (
    <Pressable
      {...pressable}
      style={style}
      hasTVPreferredFocus={preferredFocus ? true : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {children}
      {focused ? (
        <View
          pointerEvents="none"
          testID={pressable.testID ? `${pressable.testID}-focus` : undefined}
          // TV (UX-TV-33): the app's colour, with a gap around the pill.
          style={tv ? [styles.focusRingTv, styles.pillRing, { borderColor: theme.colors.accent }] : [styles.focusRing, styles.pillRing, { borderColor: theme.colors.text }]}
        />
      ) : null}
    </Pressable>
  );
};

/**
 * The phone sign-in's Back while the setup is open (UX-SETUP-08): the setup steps' Back pill, alone and full width at
 * the bottom of the screen, where every other setup screen has its Back; the sign-in's own Sign in button is its Next.
 */
export const MobileSetupBackFooter = ({ onBack }: { onBack: () => void }) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  return (
    <View testID="setup-footer" style={[styles.footer, { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg }]}>
      <SetupPill
        testID="setup-footer-back"
        accessibilityRole="button"
        accessibilityLabel={t("setup.back")}
        onPress={onBack}
        style={[styles.pill, styles.pillHalf, styles.ghost, { borderColor: theme.colors.border }]}
      >
        <Text style={{ color: theme.colors.text, fontSize: theme.font.size.md, fontWeight: "700" }}>{t("setup.back")}</Text>
      </SetupPill>
    </View>
  );
};

type MobileSetupStepProps = {
  step: number;
  total: number;
  title: string;
  body?: string;
  children?: React.ReactNode;
  /** A secondary link under the card's content, e.g. "Use another account" or "Sign in with another device". */
  secondary?: React.ReactNode;
  /** Absent on the first screen. */
  onBack?: () => void;
  /** Phone: no greyed Back pill at all when `onBack` is absent; Next takes the full width (a step shown alone, UX-SETUP-10). */
  noBack?: boolean;
  /** Absent when the step moves on by itself (sign-in completes it). */
  onNext?: () => void;
  nextDisabled?: boolean;
  busy?: boolean;
  /** The last screen says Finish instead of Next. */
  last?: boolean;
  /** The top-right language button's pick (UX-SETUP-08); see `MobileSetupHeader`. */
  onLanguage?: (code: MobileUiLanguage) => void;
  /** Replaces the default header (the TV's own numbering, or nothing once the setup is over). */
  header?: React.ReactNode;
  /** The main button's words when it is not Next / Finish (the key step's "I've written it down"). */
  nextLabel?: string;
  /** Content centred under the card, still in the scroll (the key step's "Lost your key?" line). */
  afterCard?: React.ReactNode;
  /** The mascot over the card (default: every setup step shows it, phone and TV, UX-SETUP-08); false leaves it out. */
  mascot?: boolean;
  /** TV: the remote starts on the main button (the key step's "I've written it down", UX-TV-17). */
  nextPreferredFocus?: boolean;
};

export const MobileSetupStep = (props: MobileSetupStepProps) => (Platform.isTV === true ? <MobileSetupStepTv {...props} /> : <MobileSetupStepPhone {...props} />);

const MobileSetupStepPhone = ({ step, total, title, body, children, secondary, onBack, noBack, onNext, nextDisabled, busy, last, onLanguage, header, nextLabel, afterCard, mascot = true, nextPreferredFocus }: MobileSetupStepProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const nextOff = !onNext || nextDisabled || busy;
  const scroll = useRef<ScrollViewInstance | null>(null);
  const revealEnd = useCallback(() => scroll.current?.scrollToEnd({ animated: true }), []);
  // The two pills share the row equally; a Next label too long for half the row in one line ("I've written it down")
  // has both pills sized to their labels instead, so it keeps its side padding and never wraps.
  const [wideNext, setWideNext] = useState(false);
  const pillWidth = wideNext ? styles.pillFit : styles.pillHalf;
  // The pill under the card is Back: no top link as well (UX-SETUP-08). A screen's own header (Badger's key screen)
  // is split the same way: its language button on top, its count and bar inside the card.
  const headerNode = header === undefined ? <MobileSetupHeader step={step} total={total} onLanguage={onLanguage} /> : header;
  return (
    // Keeps a step's fields (sign-in, library key) above the keyboard.
    <KeyboardAvoidingForm style={styles.fill}>
      <ScrollView
        ref={scroll}
        testID="setup-scroll"
        contentContainerStyle={[styles.scroll, { padding: theme.spacing.lg, paddingTop: theme.spacing.md, gap: theme.spacing.md }]}
        keyboardShouldPersistTaps="handled"
      >
        <SetupHeaderPart.Provider value={PHONE_TOP}>{headerNode}</SetupHeaderPart.Provider>
        <View style={styles.cardBlock}>
          {mascot ? <MobileSetupMascot /> : null}
          <MobileSetupCard title={title} body={body} mascot={mascot} top={<SetupHeaderPart.Provider value={PHONE_CARD}>{headerNode}</SetupHeaderPart.Provider>}>
            <SetupRevealEnd.Provider value={revealEnd}>{children}</SetupRevealEnd.Provider>
            {secondary ? <View style={styles.secondary}>{secondary}</View> : null}
          </MobileSetupCard>
        </View>
        {afterCard}
      </ScrollView>
      <View testID="setup-footer" style={[styles.footer, { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg, gap: theme.spacing.md }]}>
        {noBack && !onBack ? null : (
          <SetupPill
            testID="setup-footer-back"
            accessibilityRole="button"
            accessibilityLabel={t("setup.back")}
            accessibilityState={{ disabled: !onBack }}
            disabled={!onBack}
            onPress={onBack}
            style={[styles.pill, pillWidth, styles.ghost, { borderColor: theme.colors.border, opacity: onBack ? 1 : 0.5 }]}
          >
            <Text style={{ color: theme.colors.text, fontSize: theme.font.size.md, fontWeight: "700" }}>{t("setup.back")}</Text>
          </SetupPill>
        )}
        <SetupPill
          testID="setup-next"
          accessibilityRole="button"
          accessibilityLabel={nextLabel ?? (last ? t("setup.finish") : t("setup.next"))}
          accessibilityState={{ disabled: nextOff }}
          disabled={nextOff}
          onPress={onNext}
          preferredFocus={nextPreferredFocus}
          style={[styles.pill, pillWidth, { backgroundColor: theme.colors.accent, opacity: !onNext || nextDisabled ? 0.5 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator color={theme.accentTextHex} />
          ) : (
            <Text
              testID="setup-next-label"
              numberOfLines={wideNext ? 1 : undefined}
              onTextLayout={(event) => {
                if (!wideNext && event.nativeEvent.lines.length > 1) setWideNext(true);
              }}
              style={{ color: theme.accentTextHex, fontSize: theme.font.size.md, fontWeight: "800" }}
            >
              {nextLabel ?? (last ? t("setup.finish") : t("setup.next"))}
            </Text>
          )}
        </SetupPill>
      </View>
    </KeyboardAvoidingForm>
  );
};

/**
 * The TV's setup step (UX-TV-33, the approved TV mockup): one card on the sky with "STEP N OF M" and the bar at its
 * top, the title, the line, the step's content, then Back (a dark pill with an arrow) and the main button (an amber
 * pill with a chevron) at its bottom; the language button alone at the screen's top right. The mascot floats over the
 * card's top border as on the phone (UX-SETUP-08, Chris 2026-11-18), at the TV's size. Sizes are the mockup's pixels
 * halved (one dp is two pixels on a 1080p TV).
 */
const MobileSetupStepTv = ({ step, total, title, body, children, secondary, onBack, onNext, nextDisabled, busy, last, onLanguage, header, nextLabel, afterCard, mascot = true, nextPreferredFocus }: MobileSetupStepProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const nextOff = !onNext || nextDisabled || busy;
  const headerNode = header === undefined ? <MobileSetupHeader step={step} total={total} onLanguage={onLanguage} /> : header;
  const label = nextLabel ?? (last ? t("setup.finish") : t("setup.next"));
  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.scrollTv}>
        {mascot ? <MobileSetupMascot size={TV_SETUP_MASCOT_SIZE} /> : null}
        <View
          style={[styles.cardTv, { backgroundColor: `${theme.colors.surface}c7`, borderColor: `${theme.colors.border}99` }, mascot && { paddingTop: TV_STEP_CARD_TOP }]}
          testID="setup-card"
        >
          <MobileSetupTvHeaderPart part="steps">{headerNode}</MobileSetupTvHeaderPart>
          <Text accessibilityRole="header" style={[styles.titleTv, { color: theme.colors.text, fontFamily: theme.font.family.display }]}>
            {title}
          </Text>
          {body ? <Text style={[styles.bodyTv, { color: theme.colors.textMuted }]}>{body}</Text> : null}
          <View style={styles.contentTv}>{children}</View>
          {secondary ? <View style={styles.secondary}>{secondary}</View> : null}
          <View style={styles.footerTv} testID="setup-footer">
            {onBack ? (
              <SetupPill
                testID="setup-footer-back"
                accessibilityRole="button"
                accessibilityLabel={t("setup.back")}
                onPress={onBack}
                style={[styles.pillTv, { backgroundColor: `${theme.colors.surfaceRaised}8c`, borderColor: theme.colors.border, borderWidth: 0.75 }]}
              >
                <ArrowLeft size={14} color={theme.colors.text} />
                <Text style={[styles.pillLabelTv, { color: theme.colors.text }]}>{t("setup.back")}</Text>
              </SetupPill>
            ) : (
              <View />
            )}
            <SetupPill
              testID="setup-next"
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ disabled: nextOff }}
              disabled={nextOff}
              onPress={onNext}
              preferredFocus={nextPreferredFocus}
              style={[styles.pillTv, { backgroundColor: theme.colors.accent, opacity: !onNext || nextDisabled ? 0.5 : 1 }]}
            >
              {busy ? (
                <ActivityIndicator color={theme.accentTextHex} />
              ) : (
                <>
                  <Text style={[styles.pillLabelTv, { color: theme.accentTextHex }]}>{label}</Text>
                  <ChevronRight size={14} color={theme.accentTextHex} />
                </>
              )}
            </SetupPill>
          </View>
        </View>
        {afterCard ? <View style={styles.afterCardTv}>{afterCard}</View> : null}
      </ScrollView>
      <View style={styles.cornerTv} testID="setup-corner">
        <MobileSetupTvHeaderPart part="language">{headerNode}</MobileSetupTvHeaderPart>
      </View>
    </View>
  );
};

type Choice<T extends string> = { value: T; label: string; detail?: string };

/** The answers of a setup question as cards with a radio; the recommended answer comes preselected by the caller (null: none yet). */
export const MobileSetupChoices = <T extends string>({
  choices,
  selected,
  onSelect,
}: {
  choices: ReadonlyArray<Choice<T>>;
  selected: T | null;
  onSelect: (value: T) => void;
}) => {
  const theme = useMobileShellTheme();
  return (
    <View accessibilityRole="radiogroup" style={{ gap: theme.spacing.sm }}>
      {choices.map((choice) => {
        const on = choice.value === selected;
        return (
          <Pressable
            key={choice.value}
            testID={`setup-choice-${choice.value}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={choice.label}
            onPress={() => onSelect(choice.value)}
            style={[
              styles.choice,
              {
                // The chosen card: the app's colour as border and a 12% tint.
                backgroundColor: on ? `${theme.colors.accent}1f` : "#ffffff08",
                borderColor: on ? theme.colors.accent : theme.colors.border,
                padding: theme.spacing.md,
                gap: theme.spacing.md,
              },
            ]}
          >
            <View style={[styles.radio, { borderColor: on ? theme.colors.accent : theme.colors.controlBorder }]}>
              {on ? <View style={[styles.radioDot, { backgroundColor: theme.colors.accent }]} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.colors.text, fontSize: theme.font.size.md, fontWeight: "700" }}>{choice.label}</Text>
              {choice.detail ? <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.size.sm, lineHeight: 18 }}>{choice.detail}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
};

/** Height of a scrolling list: about six rows, whatever the number of choices. */
export const MOBILE_CHOICE_LIST_HEIGHT = 312;
/** Border of a scrolling list, drawn by the view around it (UX-TV-20). */
const LIST_FRAME_WIDTH = 1;
/** TV: room around the rows for the remote's ring (2.5 dp, 2 dp from the row). */
const TV_RING_ROOM = 5;
/** TV: height of a list row, and the gap between two rows (UX-TV-32), in TV design dp. */
const TV_ROW_HEIGHT = 42;
const TV_ROW_GAP = 7;
/** TV: the height, in TV design dp, of a list that shows `rows` one-line rows whole, the ring's room included. */
export const tvChoiceListHeight = (rows: number) => rows * TV_ROW_HEIGHT + (rows - 1) * TV_ROW_GAP + 2 * TV_RING_ROOM;
/** Phone: height of a list row (its bottom hairline included). */
const ROW_HEIGHT = 52;
/**
 * Height of the open list of a choice menu: five rows, so the five app languages all show with no scrolling inside the
 * list (UX-SETUP-08, Chris 2026-11-18); a sixth option would scroll. The step scrolls the open list into view.
 */
export const MOBILE_CHOICE_MENU_HEIGHT = 5 * ROW_HEIGHT + 2 * LIST_FRAME_WIDTH;

/** `lead` is drawn before the label, e.g. a language's `MobileFlag` (UX-I18N-10). */
type ListChoice<T extends string> = Choice<T> & { lead?: ReactNode };

/**
 * A list of fixed height that scrolls (UX-SETUP-06, UX-LIST-01): never a list that grows with every option. The picked
 * row is in the app's colour with a check and is scrolled into view when the list opens. A TV remote (D-pad) moves
 * through the rows: the picked row takes the focus when the list appears and the focused row shows a ring (UX-SETUP-08,
 * Badger TV's language step); a touch screen never shows the ring. Down from the last row leaves the list for the
 * control under it, Up from the first for the one above (UX-TV-20): the frame's border is drawn by a plain view around
 * the scrolling view, never by the scrolling view itself, whose rows a border would shift so that Android's ScrollView
 * never believes it reached its end and keeps the remote's Down.
 */
export const MobileChoiceList = <T extends string>({
  choices,
  selected,
  onSelect,
  height = MOBILE_CHOICE_LIST_HEIGHT,
  testID,
}: {
  choices: ReadonlyArray<ListChoice<T>>;
  selected: T;
  onSelect: (value: T) => void;
  height?: number;
  testID?: string;
}) => {
  const theme = useMobileShellTheme();
  const scroll = useRef<ScrollViewInstance | null>(null);
  const shown = useRef(false);
  const tv = Platform.isTV === true;
  return (
    <View
      style={[
        styles.listFrame,
        // TV (UX-TV-32): the rows are cards of their own inside the setup card, so the list has no frame of its own.
        tv ? styles.listFrameTv : { borderColor: theme.colors.border, borderRadius: theme.radius.md, backgroundColor: `${theme.colors.surface}e6` },
      ]}
    >
      <ScrollView
        ref={scroll}
        testID={testID}
        accessibilityRole="radiogroup"
        nestedScrollEnabled
        style={[styles.list, { maxHeight: height - (tv ? 0 : 2 * LIST_FRAME_WIDTH) }]}
        // TV: room around the rows for the remote's ring, which sits outside the focused row.
        contentContainerStyle={tv ? styles.listContentTv : undefined}
      >
        {choices.map((choice) => {
          const on = choice.value === selected;
          return (
            <ChoiceListRow
              key={choice.value}
              choice={choice}
              on={on}
              tv={tv}
              onSelect={onSelect}
              onLayout={(y) => {
                if (!on || shown.current) return;
                shown.current = true;
                scroll.current?.scrollTo({ y: Math.max(0, y - height / 2 + 26), animated: false });
              }}
            />
          );
        })}
      </ScrollView>
    </View>
  );
};

const ChoiceListRow = <T extends string>({
  choice,
  on,
  tv,
  onSelect,
  onLayout,
}: {
  choice: ListChoice<T>;
  on: boolean;
  tv: boolean;
  onSelect: (value: T) => void;
  onLayout: (y: number) => void;
}) => {
  const theme = useMobileShellTheme();
  const [focused, setFocused] = useState(false);
  const accent = theme.colors.accent;
  return (
    <Pressable
      testID={`setup-choice-${choice.value}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={choice.label}
      focusable
      // TV only: on a phone React Native's preferred focus also makes the row focusable in touch mode and focuses it, so
      // the picked row of the language menu opened with the focus ring drawn round it (as `MobileButtonFace`).
      hasTVPreferredFocus={tv && on}
      onPress={() => onSelect(choice.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onLayout={(event) => onLayout(event.nativeEvent.layout.y)}
      style={
        tv
          ? // TV (UX-TV-32): each row a rounded card; the picked one outlined and tinted in the app's colour.
            [styles.rowTv, { borderColor: on ? `${accent}b3` : `${theme.colors.border}cc`, backgroundColor: on ? `${accent}1a` : `${theme.colors.bg}73` }]
          : [styles.row, { backgroundColor: on ? `${accent}1f` : "transparent", borderBottomColor: theme.colors.border, gap: theme.spacing.md }]
      }
    >
      {choice.lead ?? null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={
            tv
              ? [styles.rowLabelTv, { color: theme.colors.text }]
              : { color: on ? accent : theme.colors.text, fontSize: theme.font.size.md, fontWeight: on ? "700" : "500" }
          }
        >
          {choice.label}
        </Text>
        {choice.detail ? (
          <Text style={tv ? [styles.detailTv, { color: theme.colors.textMuted }] : { color: theme.colors.textMuted, fontSize: theme.font.size.sm }}>
            {choice.detail}
          </Text>
        ) : null}
      </View>
      {on ? <Check size={tv ? 16 : 18} color={accent} /> : null}
      {/* Drawn over the row, so focusing never moves the rows; on TV the app's colour, with a gap around the row. */}
      {focused ? (
        <View
          testID={`setup-choice-${choice.value}-focus`}
          pointerEvents="none"
          style={tv ? [styles.focusRingTv, { borderColor: accent }] : [styles.focusRing, { borderColor: theme.colors.text }]}
        />
      ) : null}
    </Pressable>
  );
};

/**
 * A choice that can grow (the languages) as a menu (UX-LIST-01): a field showing the picked option, which opens a
 * scrolling list of capped height under it, the picked option in view; picking one closes it. In a phone setup step the
 * step scrolls to the open list's end, so its last row is never left below the screen.
 */
export const MobileChoiceMenu = <T extends string>({
  choices,
  selected,
  onSelect,
  label,
  height = MOBILE_CHOICE_MENU_HEIGHT,
  testID,
}: {
  choices: ReadonlyArray<ListChoice<T>>;
  selected: T;
  onSelect: (value: T) => void;
  /** What the menu picks, read out with the picked option. */
  label: string;
  height?: number;
  testID?: string;
}) => {
  const theme = useMobileShellTheme();
  const revealEnd = useContext(SetupRevealEnd);
  const [open, setOpen] = useState(false);
  const picked = choices.find((choice) => choice.value === selected) ?? choices[0];
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Pressable
        testID={testID ? `${testID}-field` : undefined}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${picked?.label ?? ""}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={[styles.field, { borderColor: open ? theme.colors.accent : theme.colors.controlBorder, backgroundColor: `${theme.colors.surface}e6`, gap: theme.spacing.md }]}
      >
        {picked?.lead ?? null}
        <Text style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.size.md, fontWeight: "700" }}>{picked?.label}</Text>
        <Chevron size={18} color={theme.colors.textMuted} />
      </Pressable>
      {open ? (
        <View onLayout={() => revealEnd?.()}>
          <MobileChoiceList
            testID={testID}
            choices={choices}
            selected={selected}
            height={height}
            onSelect={(value) => {
              onSelect(value);
              setOpen(false);
            }}
          />
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { flexGrow: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 24 },
  cardSteps: { gap: 10, paddingBottom: 4 },
  headerEnd: { flexDirection: "row", alignItems: "center", gap: 12 },
  eyebrow: { fontSize: 11, fontWeight: "900", letterSpacing: 2.2 },
  segments: { flexDirection: "row", gap: 4 },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  cardBlock: { flexGrow: 1, justifyContent: "center", paddingTop: 8 },
  mascotWrap: { alignSelf: "center", alignItems: "center", justifyContent: "center", zIndex: 1 },
  mascotGlow: { position: "absolute", opacity: 0.16 },
  card: { borderWidth: 1, borderRadius: 20, paddingTop: 34 },
  title: { fontSize: 24, fontWeight: "700", lineHeight: 30 },
  secondary: { alignItems: "center", paddingTop: 4 },
  footer: { flexDirection: "row" },
  pill: { minHeight: 48, paddingHorizontal: 20, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  pillHalf: { flex: 1 },
  pillFit: { flexGrow: 1, flexShrink: 1, flexBasis: "auto" },
  ghost: { borderWidth: 1, backgroundColor: "#ffffff0d" },
  choice: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  listFrame: { borderWidth: LIST_FRAME_WIDTH, overflow: "hidden", flexShrink: 1 },
  listFrameTv: { borderWidth: 0 },
  listContentTv: { padding: TV_RING_ROOM, gap: TV_ROW_GAP },
  // A row is 42 dp with one line, and grows with a detail's lines so none is clipped (UX-SETUP-08: "How should titles
  // appear?" in French); `tvChoiceListHeight` counts one-line rows.
  rowTv: { flexDirection: "row", alignItems: "center", minHeight: TV_ROW_HEIGHT, paddingVertical: 8, paddingHorizontal: 14, gap: 11, borderRadius: 8, borderWidth: 0.75 },
  rowLabelTv: { fontSize: 14, fontWeight: "600" },
  detailTv: { fontSize: 11, lineHeight: 15 },
  focusRingTv: { position: "absolute", top: -4.5, left: -4.5, right: -4.5, bottom: -4.5, borderWidth: 2.5, borderRadius: 12 },
  list: { flexGrow: 0 },
  row: { flexDirection: "row", alignItems: "center", minHeight: ROW_HEIGHT, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  field: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 14, borderWidth: 1, borderRadius: 14 },
  focusRing: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderWidth: 3, borderRadius: 6 },
  pillRing: { borderRadius: 999 },
  // TV (UX-TV-33): the mockup's pixels halved, tightened so the key step's 12 boxes, the other-device card and the
  // buttons fit 540 dp with the mascot over the card (UX-SETUP-08, as the desktop's `LIBRARY_KEY_STEP_FIT`); the card
  // sits in the middle of the screen.
  scrollTv: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingTop: 6, paddingBottom: 6 },
  afterCardTv: { marginTop: 8 },
  cardTv: { width: 620, borderWidth: 0.75, borderRadius: 10, paddingTop: 23, paddingHorizontal: 28, paddingBottom: 16 },
  cornerTv: { position: "absolute", top: 28, right: 36 },
  eyebrowTv: { fontWeight: "900" },
  segmentsTv: { flexDirection: "row" },
  segmentTv: { flex: 1 },
  titleTv: { marginTop: 10, fontSize: 28, lineHeight: 34, fontWeight: "600" },
  bodyTv: { marginTop: 7, fontSize: 12, lineHeight: 17.5 },
  contentTv: { marginTop: 10, gap: 10 },
  footerTv: { marginTop: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pillTv: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, height: 36, paddingHorizontal: 18, borderRadius: 999 },
  pillLabelTv: { fontSize: 12.5, fontWeight: "700" },
});
