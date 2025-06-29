const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const _ = require('lodash');
var fs = require('fs');
var moment = require('moment');
var mysql = require('mysql2');
const superagent = require('superagent');

module.exports = {
  fetchAreaNests: async function fetchAreaNests(client, areaName, config, master, shinies) {
    var areaQuery = `SELECT lat, lon, name, area_name, pokemon_id, pokemon_form, pokemon_avg FROM nests WHERE pokemon_id > 0 AND pokemon_avg >= ${config.minimumAverage} AND area_name = "${areaName}"`
    if (config.includeUnknown == false) {
      areaQuery = areaQuery.concat(` AND name != ${config.renameUnknownFrom}`);
    }
    areaQuery = areaQuery.concat(` ORDER BY ${config.nestBoardOrder.replace('pokemon_name', 'pokemon_id').replace('nest_name', 'name')} ASC;`);
    if (config.nestBoardOrder == 'pokemon_avg') {
      areaQuery = areaQuery.replace('ASC;', 'DESC;');
    }
    var areaResults = await this.runQuery(config, areaQuery);
    var areaNests = [];
    var markers = [];
    var points = [];



    for (var a = 0; a < areaResults.length; a++) {
      var nestInfo = areaResults[a];
      //Pokemon name
      let pokeInfo = master.monsters[`${nestInfo['pokemon_id']}_${nestInfo['pokemon_form']}`];
      let pokeNameTranslation = master.translations[config.language ? config.language : 'en'].pokemon[`poke_${nestInfo['pokemon_id']}`];
      let pokeFormTranslation = master.translations[config.language ? config.language : 'en'].forms[`form_${nestInfo['pokemon_form']}`];
      var pokemonName = pokeNameTranslation;
      if (pokeInfo.form.name && !config.ignoredFormNames.includes(pokeInfo.form.name)) {
        pokemonName = pokemonName.concat(` ${pokeFormTranslation}`);
        //Remove any ending in form
        if (pokemonName.endsWith(' Form') || pokemonName.endsWith(' Forme')) {
          pokemonName = pokemonName.replace(' Forme', '').replace(' Form', '');
        }
      }
      nestInfo.pokemonName = pokemonName;

      //Rename
      if (nestInfo.name == config.renameUnknownFrom) {
        nestInfo.name = config.renameUnknownTo;
      }

      //Types
      nestInfo.type = config.emojis[`type-${pokeInfo.types[0]['name'].toLowerCase()}`];
      if (pokeInfo.types[1]) {
        nestInfo.type = nestInfo.type.concat(`/${config.emojis[`type-${pokeInfo.types[1]['name'].toLowerCase()}`]}`);
      }

      //Shiny
      nestInfo.shiny = '';
      if (nestInfo.pokemon_form == 0 || pokeInfo.form.name == 'Normal') {
        if (shinies[nestInfo.pokemon_id] == ' ✨') {
          nestInfo.shiny = '✨';
        }
      } else if (shinies[`${nestInfo.pokemon_id}_${nestInfo.pokemon_form}`] == ' ✨' || shinies[`${nestInfo.pokemon_id}_${nestInfo.pokemon_form}*`]) {
        nestInfo.shiny = '✨';
      }

      areaNests.push(nestInfo);
    } //End of a loop

    //Sort by Pokemon
    if (config.nestBoardOrder == 'pokemon_name') {
      areaNests = _.sortBy(areaNests, 'pokemonName');
    }

    //Create board entries
    var boardEntries = [];
    for (var n = 0; n < areaNests.length; n++) {
      var nestName = areaNests[n]['name'];

      //Links
      if (config.areaNameLink == true) {
        let nestLink = config.linkFormat.replace('{{lat}}', areaNests[n]['lat']).replace('{{lon}}', areaNests[n]['lon']);
        nestName = `[${areaNests[n]['name']}](${nestLink})`;
      }

      let nestEntry = config.boardFormat.replace('{{dex}}', areaNests[n]['pokemon_id']).replace('{{pokemon}}', areaNests[n]['pokemonName']).replace('{{shiny}}', areaNests[n]['shiny']).replace('{{type}}', areaNests[n]['type']).replace('{{avg}}', areaNests[n]['pokemon_avg'].toFixed(config.averageToFixed)).replace('{{name}}', nestName);
      boardEntries.push(nestEntry);

      //Check length
      if (boardEntries.join('\n').length > 4096) {
        boardEntries.pop();
        break;
      }

      markers.push([areaNests[n]['pokemon_id'], areaNests[n]['pokemon_form'], areaNests[n]['lat'], areaNests[n]['lon']]);
      points.push({
        latitude: areaNests[n]['lat'],
        longitude: areaNests[n]['lon']
      });
    } //End of n loop

    //Create title
    var title = config.titleFormat.replace('{{area}}', areaName);
    if (config.replaceUnderscores == true) {
      var title = title.replaceAll('_', ' ');
    }

    //Find center/zoom
    let tileData = await this.findCenterZoom(points, config.tileWidth, config.tileHeight);
    var miniMapLink = '';

    //Create embed
    nestEmbed = new EmbedBuilder().setTitle(title).setDescription(boardEntries.join('\n')).setTimestamp();

    //No nests
    if (areaResults.length == 0) {
      nestEmbed.setDescription(config.noNestsFound ? config.noNestsFound : 'No nests found.');
      return [nestEmbed, areaName];
    }
    //Nests with map
    else if (config.tileServerURL) {
      let imageUrl = "";
      try {
        const res = await superagent.post(`${config.tileServerURL}/staticmap/nest-bot?pregenerate=true&regeneratable=true`)
          .send({
            "height": config.tileHeight,
            "width": config.tileWidth,
            "lat": tileData.latitude,
            "lon": tileData.longitude,
            "zoom": tileData.zoom,
            "nestjson": markers
          });

        imageUrl = `${config.tileServerURL}/staticmap/pregenerated/${res.text}`;

        if (
          config.enableDummyUpload === true &&
          config.dummyChannelId &&
          typeof config.dummyChannelId === "string" &&
          config.dummyChannelId.trim() !== ""
        ) {
          const tempFilePath = `./temp_nestmap_${Date.now()}.png`;
          const imageRes = await superagent.get(imageUrl).responseType('blob');
          fs.writeFileSync(tempFilePath, imageRes.body);

          const dummyChannel = await client.channels.fetch(config.dummyChannelId);
          const uploadMsg = await dummyChannel.send({ files: [tempFilePath] });
          const cdnUrl = uploadMsg.attachments.first().url;
          nestEmbed.setImage(cdnUrl);

          fs.unlinkSync(tempFilePath);
        } else {
          nestEmbed.setImage(imageUrl);
        }

      } catch (err) {
        if (imageUrl) {
          nestEmbed.setImage(imageUrl);
        } else if (typeof config.tileServerURL === "string" && config.tileServerURL.length > 0) {
          nestEmbed.setImage(config.tileServerURL);
        }
      }
      return [nestEmbed, areaName];
    }
    //Nests without map
    else {
      return [nestEmbed, areaName];
    }
  }, //End of fetchAreaNests()


  //Find center/zoom
  findCenterZoom: async function findCenterZoom(points, width, height, margin = 1.25, defaultZoom = 17.5) {
    width /= margin
    height /= margin

    const objs = []
    if (points) {
      objs.push(...points.map((x) => [x.latitude, x.longitude]))
    }
    if (!objs.length) return
    const lats = objs.map(([lat]) => lat)
    const lons = objs.map(([, lon]) => lon)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLon = Math.min(...lons)
    const maxLon = Math.max(...lons)
    const latitude = minLat + ((maxLat - minLat) / 2.0)
    const longitude = minLon + ((maxLon - minLon) / 2.0)
    const ne = [maxLat, maxLon]
    const sw = [minLat, minLon]

    // If only one point, pad the bounds slightly
    if (objs.length === 1) {
      const pad = 0.002; // ~200m, adjust as needed
      return {
        zoom: defaultZoom,
        latitude: lats[0],
        longitude: lons[0],
        bounds: {
          ne: [lats[0] + pad, lons[0] + pad],
          sw: [lats[0] - pad, lons[0] - pad]
        }
      }
    }

    function latRad(lat) {
      const sin = Math.sin(lat * Math.PI / 180.0)
      const rad = Math.log((1.0 + sin) / (1.0 - sin)) / 2.0
      return Math.max(Math.min(rad, Math.PI), -Math.PI) / 2.0
    }

    function roundToTwo(num) {
      return +(`${Math.round(`${num}e+2`)}e-2`)
    }

    function zoom(px, fraction) {
      return roundToTwo(Math.log2(px / 256.0 / fraction))
    }
    const latFraction = (latRad(ne[0]) - latRad(sw[0])) / Math.PI
    let angle = ne[1] - sw[1]
    if (angle < 0.0) angle += 360.0
    const lonFraction = angle / 360.0
    return {
      zoom: Math.min(zoom(height, latFraction), zoom(width, lonFraction)),
      latitude,
      longitude,
    }
  }, //End of findCenterZoom()

  //Run query
  runQuery: async function runQuery(config, query) {
    let connection = mysql.createConnection(config.nest_db);
    return new Promise((resolve, reject) => {
      connection.query(query, (error, results) => {
        if (error) {
          connection.end();
          console.log(error)
          return resolve(`ERROR`);
        } else {
          connection.end();
          return resolve(results);
        }
      });
    });
  } //End of runQuery()
}