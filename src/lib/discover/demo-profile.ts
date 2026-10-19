export interface DemoAnchorSpec {
  query: string;
  type: string;
  note: string;
}

export interface DemoProfile {
  name: string;
  city: string;
  description: string;
  anchors: DemoAnchorSpec[];
}

export const MUMBAI_NEWCOMER: DemoProfile = {
  name: "Mumbai Newcomer — Berlin Starter Kit",
  city: "Berlin",
  description:
    "A newcomer from Mumbai exploring Berlin through music and film they already love.",
  anchors: [
    {
      query: "Radiohead",
      type: "urn:entity:artist",
      note: "Resolves cleanly to a single artist.",
    },
    {
      query: "Asha Bhosle",
      type: "urn:entity:artist",
      note: "Resolves cleanly to the legendary Indian playback singer.",
    },
    {
      query: "Prateek Kuhad",
      type: "urn:entity:artist",
      note: "Resolves cleanly to the Indian indie singer-songwriter.",
    },
    {
      query: "Slumdog Millionaire",
      type: "urn:entity:movie",
      note: "Resolves cleanly to the 2008 film.",
    },
    {
      query: "The Office",
      type: "urn:entity:tv_show",
      note: "Intentionally ambiguous — multiple versions exist. Must not be silently chosen.",
    },
  ],
};
