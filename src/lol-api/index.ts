import { SubEvent } from 'sub-events';
import fetch from "electron-fetch";
import request from "./request";
import Store from "electron-store";
import WebSocket from "ws";
import { tryParseJson } from "../json-try-parse";
import { LeagueDetails, CurrentSummoner, ChampKey, ChampData, ChampLoadout, EventData, RuneDetails, SummonerSpell, ApiError } from "./LeagueApiInterfaces";
import { getLeagueDetails } from "./getLeagueDetails";
import _ from "lodash";
import { leagueVersion } from "../../package.json";

const store = new Store();

export default class lolapi {

  public leagueDetails: LeagueDetails = null;
  public currentSummoner: CurrentSummoner = null;
  private socket: WebSocket = null;
  private champKeys: ChampKey[] = null;
  private summonerSpells: SummonerSpell[] = null;
  private currentSelectedChamp: ChampData = { champion: "", role: "" };
  private categories: RuneDetails[] = [];
  private perks: RuneDetails[] = [];

  //#region Events
  public onChampSelected: SubEvent<ChampData> = new SubEvent();
  public onChampSwapped: SubEvent<ChampData> = new SubEvent();
  //#endregion

  //#region Start/Stop Methods

  public start = async () => {
    const newDetails = await getLeagueDetails();
    this.champKeys = await this.getChampKeys(leagueVersion);
    this.summonerSpells = await this.getSummonerSpells(leagueVersion);
    if (newDetails !== null && !_.isEqual(newDetails, this.leagueDetails)) {
      this.leagueDetails = newDetails;
      console.log(`URL: https://127.0.0.1:${this.leagueDetails["app-port"]}/`);
      console.log(`B64Key: ${this.getAuthKey(true)}`);
      //All league API code goes after here!
      this.categories = await this.getRuneCategories();
      this.perks = await this.getRunePerks();
      this.currentSummoner = await this.getCurrentSummoner();
      const webSocketUrl = `wss://${this.getAuthKey(false)}@localhost:${newDetails["app-port"]}`;
      this.socket = new WebSocket(webSocketUrl, { rejectUnauthorized: false });
      this.socket.on("open", () => {
        this.socket.send(JSON.stringify([5, "OnJsonApiEvent_lol-champ-select_v1_session"]));
        this.socket.on("message", (data) => {
          const dataArr: [] = tryParseJson(data.toString());
          if (dataArr !== null) {
            const champData: EventData = dataArr.find(x => typeof x === "object");
            if (champData.eventType === "Update") {
              const currentSummonersChamp = champData.data.myTeam.find(x => x.summonerId === this.currentSummoner.summonerId);
              if (currentSummonersChamp.championId != 0 || currentSummonersChamp.championPickIntent != 0) {
                const cId = currentSummonersChamp.championId != 0 ? currentSummonersChamp.championId : currentSummonersChamp.championPickIntent;
                const champKey: ChampKey = this.champKeys.find(champ => champ.key === cId);
                if (this.currentSelectedChamp.champion !== champKey.id) {
                  const emitData: ChampData = { champion: champKey.id, role: currentSummonersChamp.assignedPosition };
                  this.currentSelectedChamp = emitData;
                  this.onChampSelected.emit(emitData);
                }
              }
            }
          }
        });
        this.socket.on("close", (code, reason) => {
          console.log(`Closed: ${code}: ${reason}`);
        })
      });
    }
  }

  public stop = () => {
    this.socket?.close();
  }

  public importChampLoadout = async (loadout: ChampLoadout): Promise<void> => {
    if (this.leagueDetails !== null) {
      const parsedCategories = loadout.trees.map(tree => this.categories.find(category => category.name === tree).id);
      const mappedShards = this.mapShards(loadout.shards);
      const parsedPerks = [...loadout.perks, ...mappedShards].map(uggperk => this.perks.find(perk => perk.name === uggperk).id);
      const runePayload = {
        name: `Import: ${this.currentSelectedChamp.champion} ${this.currentSelectedChamp.role}`,
        primaryStyleId: parsedCategories[0],
        selectedPerkIds: parsedPerks,
        subStyleId: parsedCategories[1]
      };
      const spellIds = loadout.spells.map(spellName => this.summonerSpells.find(summSpell => summSpell.name === spellName).key);
      const spellPayload = {
        "spell1Id": spellIds[0],
        "spell2Id": spellIds[1],
      }
      await this.pushRunes(JSON.stringify(runePayload))
        .then(_ => this.pushSpells(JSON.stringify(spellPayload)));
    }
  }

  //#endregion

  //#region Private Methods

  private getAuthKey = (base64: boolean): string => {
    if (this.leagueDetails === null)
      return null;
    return base64 ?
      Buffer.from(`riot:${this.leagueDetails["remoting-auth-token"]}`).toString("base64") :
      `riot:${this.leagueDetails["remoting-auth-token"]}`;
  }

  private getCurrentSummoner = async (): Promise<CurrentSummoner> => {
    if (this.leagueDetails !== null) {
      const req: { response?: CurrentSummoner, error?: ApiError } = await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-summoner/v1/current-summoner", "GET");
      if (req.response) {
        return req.response;
      }
      else {
        return null;
      }
    }
  }

  private getAvailableRunePage = async (): Promise<{ id: number, name: string, isEditable: boolean }[]> => {
    if (this.leagueDetails !== null) {
      const req: { response?: { id: number, name: string, isEditable: boolean }[], error?: ApiError } = await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-perks/v1/pages", "GET");
      if (req.response) {
        return req.response;
      }
      else {
        return [];
      }
    }
  }

  private getChampKeys = async (version: string): Promise<ChampKey[]> => {
    if (store.has(`ChampKeys${version}`))
      return store.get(`ChampKeys${version}`) as ChampKey[];
    const bulkData: { data: any[] } = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`).then(val => val.json())
    const parsedData = Object.values(bulkData.data).reduce((prev: ChampKey[], curr: { id: string, key: string }) => {
      return [...prev, { id: curr.id, key: parseInt(curr.key) }]
    }, [] as ChampKey[]);
    store.set(`ChampKeys${version}`, parsedData);
    return parsedData;
  }

  private getSummonerSpells = async (version: string): Promise<SummonerSpell[]> => {
    if (store.has(`SummonerSpell${version}`))
      return store.get(`SummonerSpell${version}`) as SummonerSpell[];
    store.clear();
    const bulkData: { data: any[] } = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`).then(val => val.json())
    const parsedData = Object.values(bulkData.data).reduce((prev: SummonerSpell[], curr: { name: string, key: string }) => {
      return [...prev, { name: curr.name, key: parseInt(curr.key) }]
    }, [] as SummonerSpell[]);
    store.set(`SummonerSpell${version}`, parsedData);
    return parsedData;
  }

  private getRuneCategories = async (): Promise<RuneDetails[]> => {
    if (this.leagueDetails !== null) {
      const req: { response?: RuneDetails[], error?: ApiError } = await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-perks/v1/styles", "GET");
      if (req.response) {
        return req.response;
      }
      else {
        return null;
      }
    }
  }

  private getRunePerks = async (): Promise<RuneDetails[]> => {
    if (this.leagueDetails !== null) {
      const req: { response?: RuneDetails[], error?: ApiError } = await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-perks/v1/perks", "GET");
      if (req.response) {
        return req.response;
      }
      else {
        return null;
      }
    }
  }

  private pushRunes = async (runeData: string): Promise<void> => {
    const availableRunePages = await this.getAvailableRunePage();
    const importedPages = availableRunePages.filter(x => x.name.includes("Import:"));
    if (importedPages.length > 0) {
      let deletePromises: Promise<void>[] = [];
      importedPages.forEach((val) => deletePromises.push(this.deleteRunePage(val.id)));
      await Promise.all(deletePromises);
    }
    const req = await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-perks/v1/pages", "POST", runeData);
    if (req.error) {
      if (req.error.message === "Max pages reached") {
        const firstEditablePage = availableRunePages.find(x => x.isEditable).id;
        await this.deleteRunePage(firstEditablePage);
        await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-perks/v1/pages", "POST", runeData);
      }
    }
  }

  private pushSpells = async (spells: string): Promise<void> => {
    await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], "/lol-champ-select/v1/session/my-selection", "PATCH", spells);
  }

  private deleteRunePage = async (id: number): Promise<void> => {
    await request("127.0.0.1", this.leagueDetails["app-port"], this.leagueDetails["remoting-auth-token"], `/lol-perks/v1/pages/${id}`, "DELETE");
  }

  private mapShards = (shards: string[]): string[] => {
    return shards.map(shard => {
      shard = shard.replace("rune-", "");
      switch (shard) {
        case "Health":
          shard = "HealthScaling";
          break;
        case "Magic":
          shard = "MagicRes";
          break;
        case "CDR":
          shard = "CDRScaling";
          break;
        case "AdaptiveForce":
          shard = "Adaptive";
          break;
        default:
          break;
      }
      return shard;
    });
  }

  //#endregion
}