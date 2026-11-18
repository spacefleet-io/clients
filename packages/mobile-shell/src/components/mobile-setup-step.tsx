/**
 * One screen of the phone setup walkthrough (UX-SETUP-02, UX-SETUP-08): "‹ Back" and "STEP N OF M" on top, a segmented
 * step bar, the app's mascot over a frosted card holding the question and its answers or form, and pill Back and Next
 * buttons under the card. Transparent: the app's sky shows through (UX-SKY-02). Takes the app's colours from the shell
 * theme (Badger amber, Parrot green).
 */
import React, { useContext, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingForm } from "../keyboard";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation, type MobileUiLanguage } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileLanguageMenu } from "./mobile-language-menu";

/** Fill of a step bar segment not reached yet. */
const SEGMENT_OFF = "#ffffff1f";

/**
 * The top of every setup screen: "‹ Back" in the app's colour (absent on the first step), "STEP N OF M", the language
 * button in the top-right corner, and a bar of one segment per step, those reached in the app's colour. Also on top of
 * the app's own sign-in and key screens. Step 0 (the language and the sign-in, before the numbered steps, UX-SETUP-08)
 * shows Back only. The language button stays in that corner for the whole setup (UX-SETUP-08): `onLanguage` switches
 * the app's language; the sign-in screens leave it out since their own corner already holds one.
 */
/**
 * TV (UX-TV-33): which part of the header a setup screen draws where. The step's card holds "STEP N OF M" and the
 * bar (`steps`); the language button sits alone at the screen's top right (`language`). The phone draws it all at once.
 */
const SetupHeaderPart = React.createContext<"all" | "steps" | "language">("all");

export const MobileSetupHeader = ({
  step,
  total,
  onBack,
  onLanguage,
}: {
  step: number;
  total: number;
  onBack?: () => void;
  onLanguage?: (code: MobileUiLanguage) => void;
}) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const part = useContext(SetupHeaderPart);
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
      <View style={styles.stepsTv} testID="setup-step-bar">
        <Text testID="setup-step-indicator" style={[styles.eyebrowTv, { color: theme.colors.accent }]}>
          {t("setup.stepOf", { step, total }).toUpperCase()}
        </Text>
        <View style={styles.segmentsTv} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {Array.from({ length: total }, (_, index) => (
            <View key={index} style={[styles.segmentTv, { backgroundColor: index < step ? theme.colors.accent : theme.colors.surfaceRaised }]} />
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 10 }} testID="setup-step-bar">
      <View style={styles.headerRow}>
        {onBack ? (
          <Pressable testID="setup-back" accessibilityRole="button" accessibilityLabel={t("setup.back")} onPress={onBack} hitSlop={12}>
            <Text style={[styles.backLink, { color: theme.colors.accent }]}>{`‹ ${t("setup.back")}`}</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <View style={styles.headerEnd}>
          {counted ? (
            <Text testID="setup-step-indicator" style={[styles.eyebrow, { color: theme.colors.textMuted }]}>
              {t("setup.stepOf", { step, total }).toUpperCase()}
            </Text>
          ) : null}
          {language}
        </View>
      </View>
      {counted ? (
      <View style={styles.segments} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {Array.from({ length: total }, (_, index) => (
          <View key={index} style={[styles.segment, { backgroundColor: index < step ? theme.colors.accent : SEGMENT_OFF }]} />
        ))}
      </View>
      ) : null}
    </View>
  );
};

/** The app's mascot floating over the setup card, with a soft glow in the app's colour. */
export const MobileSetupMascot = () => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.mascotWrap} pointerEvents="none">
      <View style={[styles.mascotGlow, { backgroundColor: theme.colors.accent }]} />
      <Image source={theme.mascotSource} style={styles.mascot} resizeMode="contain" accessibilityIgnoresInvertColors />
    </View>
  );
};

/** The frosted card of a setup screen: title in the display face, optional body, then the step's content. */
export const MobileSetupCard = ({
  title,
  body,
  children,
  mascot = true,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
  /** The mascot overlaps the card's top; without it the card's top padding is its usual one. */
  mascot?: boolean;
}) => {
  const theme = useMobileShellTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: `${theme.colors.surface}c7`, borderColor: theme.colors.border, padding: theme.spacing.lg, gap: theme.spacing.md },
        !mascot && { paddingTop: theme.spacing.lg },
      ]}
    >
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
  /** The mascot over the card; the TV's key step leaves it out so its 12 words fit the 960x540 screen. */
  mascot?: boolean;
  /** TV: the remote starts on the main button (the key step's "I've written it down", UX-TV-17). */
  nextPreferredFocus?: boolean;
};

export const MobileSetupStep = (props: MobileSetupStepProps) => (Platform.isTV === true ? <MobileSetupStepTv {...props} /> : <MobileSetupStepPhone {...props} />);

const MobileSetupStepPhone = ({ step, total, title, body, children, secondary, onBack, onNext, nextDisabled, busy, last, onLanguage, header, nextLabel, afterCard, mascot = true, nextPreferredFocus }: MobileSetupStepProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const nextOff = !onNext || nextDisabled || busy;
  return (
    // Keeps a step's fields (sign-in, library key) above the keyboard.
    <KeyboardAvoidingForm style={styles.fill}>
      {/* Top padding as `MobileScreen`'s: the header stays put between these steps and the app's own setup screens
          (Badger's library key) that show it inside a `MobileScreen`. */}
      <ScrollView
        contentContainerStyle={[styles.scroll, { padding: theme.spacing.lg, paddingTop: theme.spacing.md, gap: theme.spacing.md }]}
        keyboardShouldPersistTaps="handled"
      >
        {header === undefined ? <MobileSetupHeader step={step} total={total} onBack={onBack} onLanguage={onLanguage} /> : header}
        <View style={styles.cardBlock}>
          {mascot ? <MobileSetupMascot /> : null}
          <MobileSetupCard title={title} body={body} mascot={mascot}>
            {children}
            {secondary ? <View style={styles.secondary}>{secondary}</View> : null}
          </MobileSetupCard>
        </View>
        {afterCard}
      </ScrollView>
      <View style={[styles.footer, { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg, gap: theme.spacing.md }]}>
        <SetupPill
          testID="setup-footer-back"
          accessibilityRole="button"
          accessibilityLabel={t("setup.back")}
          accessibilityState={{ disabled: !onBack }}
          disabled={!onBack}
          onPress={onBack}
          style={[styles.pill, styles.ghost, { borderColor: theme.colors.border, opacity: onBack ? 1 : 0.4 }]}
        >
          <Text style={{ color: theme.colors.text, fontSize: theme.font.size.md, fontWeight: "700" }}>{t("setup.back")}</Text>
        </SetupPill>
        <SetupPill
          testID="setup-next"
          accessibilityRole="button"
          accessibilityLabel={nextLabel ?? (last ? t("setup.finish") : t("setup.next"))}
          accessibilityState={{ disabled: nextOff }}
          disabled={nextOff}
          onPress={onNext}
          preferredFocus={nextPreferredFocus}
          style={[styles.pill, { backgroundColor: theme.colors.accent, opacity: !onNext || nextDisabled ? 0.4 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator color={theme.accentTextHex} />
          ) : (
            <Text style={{ color: theme.accentTextHex, fontSize: theme.font.size.md, fontWeight: "800" }}>
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
 * pill with a chevron) at its bottom; the language button alone at the screen's top right. The mascot is left out so
 * the 12 words fit 960x540. Sizes are the mockup's pixels halved (one dp is two pixels on a 1080p TV).
 */
const MobileSetupStepTv = ({ step, total, title, body, children, secondary, onBack, onNext, nextDisabled, busy, last, onLanguage, header, nextLabel, afterCard, nextPreferredFocus }: MobileSetupStepProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const nextOff = !onNext || nextDisabled || busy;
  const headerNode = header === undefined ? <MobileSetupHeader step={step} total={total} onBack={onBack} onLanguage={onLanguage} /> : header;
  const label = nextLabel ?? (last ? t("setup.finish") : t("setup.next"));
  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.scrollTv}>
        <View style={[styles.cardTv, { backgroundColor: `${theme.colors.surface}c7`, borderColor: `${theme.colors.border}99` }]} testID="setup-card">
          <SetupHeaderPart.Provider value="steps">{headerNode}</SetupHeaderPart.Provider>
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
              style={[styles.pillTv, { backgroundColor: theme.colors.accent, opacity: !onNext || nextDisabled ? 0.4 : 1 }]}
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
        {afterCard}
      </ScrollView>
      <View style={styles.cornerTv} testID="setup-corner">
        <SetupHeaderPart.Provider value="language">{headerNode}</SetupHeaderPart.Provider>
      </View>
    </View>
  );
};

type Choice<T extends string> = { value: T; label: string; detail?: string };

/** The answers of a setup question as cards with a radio; the recommended answer comes preselected by the caller. */
export const MobileSetupChoices = <T extends string>({
  choices,
  selected,
  onSelect,
}: {
  choices: ReadonlyArray<Choice<T>>;
  selected: T;
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
/** Height of the open list of a choice menu: about four rows, so it never pushes the setup card off the screen. */
export const MOBILE_CHOICE_MENU_HEIGHT = 216;

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
      hasTVPreferredFocus={on}
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
        {choice.detail ? <Text style={{ color: theme.colors.textMuted, fontSize: theme.font.size.sm }}>{choice.detail}</Text> : null}
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
 * scrolling list of capped height under it, the picked option in view; picking one closes it.
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
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { flexGrow: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 24 },
  headerEnd: { flexDirection: "row", alignItems: "center", gap: 12 },
  backLink: { fontSize: 15, fontWeight: "700" },
  eyebrow: { fontSize: 11, fontWeight: "900", letterSpacing: 2.2 },
  segments: { flexDirection: "row", gap: 4 },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  cardBlock: { flexGrow: 1, justifyContent: "center", paddingTop: 8 },
  mascotWrap: { alignSelf: "center", width: 96, height: 84, alignItems: "center", justifyContent: "center", marginBottom: -26, zIndex: 1 },
  mascotGlow: { position: "absolute", width: 72, height: 72, borderRadius: 36, opacity: 0.16 },
  mascot: { width: 84, height: 84 },
  card: { borderWidth: 1, borderRadius: 20, paddingTop: 34 },
  title: { fontSize: 24, fontWeight: "700", lineHeight: 30 },
  secondary: { alignItems: "center", paddingTop: 4 },
  footer: { flexDirection: "row" },
  pill: { flex: 1, minHeight: 48, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  ghost: { borderWidth: 1, backgroundColor: "#ffffff0d" },
  choice: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  listFrame: { borderWidth: LIST_FRAME_WIDTH, overflow: "hidden", flexShrink: 1 },
  listFrameTv: { borderWidth: 0 },
  listContentTv: { padding: TV_RING_ROOM, gap: 7 },
  rowTv: { flexDirection: "row", alignItems: "center", height: 42, paddingHorizontal: 14, gap: 11, borderRadius: 8, borderWidth: 0.75 },
  rowLabelTv: { fontSize: 14, fontWeight: "600" },
  focusRingTv: { position: "absolute", top: -4.5, left: -4.5, right: -4.5, bottom: -4.5, borderWidth: 2.5, borderRadius: 12 },
  list: { flexGrow: 0 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  field: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 14, borderWidth: 1, borderRadius: 14 },
  focusRing: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderWidth: 3, borderRadius: 6 },
  pillRing: { borderRadius: 999 },
  // TV (UX-TV-33): the mockup's pixels halved.
  scrollTv: { flexGrow: 1, alignItems: "center", paddingTop: 48, paddingBottom: 24, gap: 12 },
  cardTv: { width: 620, borderWidth: 0.75, borderRadius: 10, paddingTop: 23, paddingHorizontal: 28, paddingBottom: 22 },
  cornerTv: { position: "absolute", top: 28, right: 36 },
  stepsTv: { gap: 8 },
  eyebrowTv: { fontSize: 11, fontWeight: "900", letterSpacing: 1.44 },
  segmentsTv: { flexDirection: "row", gap: 4 },
  segmentTv: { flex: 1, height: 3, borderRadius: 1.5 },
  titleTv: { marginTop: 15, fontSize: 28, lineHeight: 34, fontWeight: "600" },
  bodyTv: { marginTop: 7, fontSize: 12, lineHeight: 17.5 },
  contentTv: { marginTop: 15, gap: 10 },
  footerTv: { marginTop: 17, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pillTv: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, height: 36, paddingHorizontal: 18, borderRadius: 999 },
  pillLabelTv: { fontSize: 12.5, fontWeight: "700" },
});
