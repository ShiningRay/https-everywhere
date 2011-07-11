function Rule(from, to) {
  this.from = from;
  this.to = to;
  this.from_c = new RegExp(from);
}

function Exclusion(pattern) {
  this.pattern = pattern;
  this.pattern_c = new RegExp(pattern);
}

function CookieRule(host, cookiename) {
  this.host = host
  this.host_c = new RegExp(host);
  this.name = cookiename;
  this.name_c = new RegExp(cookiename);
}

ruleset_counter = 0;
function RuleSet(name, match_rule, default_off) {
  this.id="https-everywhere-rule-" + ruleset_counter;
  ruleset_counter += 1;
  this.on_by_default = true;
  this.name = name;
  this.ruleset_match = match_rule;
  this.notes = "";
  if (match_rule)   this.ruleset_match_c = new RegExp(match_rule)
  else              this.ruleset_match_c = null;
  if (default_off) {
    // Perhaps problematically, this currently ignores the actual content of
    // the default_off XML attribute.  Ideally we'd like this attribute to be
    // "valueless"
    this.notes = default_off;
    this.on_by_default = false;
  }
  this.rules = [];
  this.exclusions = [];
  this.cookierules = [];
  this.prefs = HTTPSEverywhere.instance.get_prefs();
  try {
    // if this pref exists, use it
    this.active = this.prefs.getBoolPref(name);
  } catch (e) {
    // if not, create it
    this.log(DBUG, "Creating new pref " + name);
    this.active = this.on_by_default;
    this.prefs.setBoolPref(name, this.on_by_default);
  }
}

RuleSet.prototype = {
  _apply: function(urispec) {
    // return null if it does not apply
    // and the new url if it does apply
    var i;
    var returl = null;
    // If a rulset has a match_rule and it fails, go no further
    if (this.ruleset_match_c && !this.ruleset_match_c.test(urispec)) {
      this.log(VERB, "ruleset_match_c excluded " + urispec);
      return null;
    }
    // Even so, if we're covered by an exclusion, go home
    for (i = 0; i < this.exclusions.length; ++i) {
      if (this.exclusions[i].pattern_c.test(urispec)) {
        this.log(DBUG,"excluded uri " + urispec);
        return null;
      }
    }
    // Okay, now find the first rule that triggers
    for (i = 0; i < this.rules.length; ++i) {
      // This is just for displaying inactive rules
      returl = urispec.replace(this.rules[i].from_c, this.rules[i].to);
      if (returl != urispec) return returl;
    }

    return null;
  },
  log: function(level, msg) {
    https_everywhereLog(level, msg);
  },
 
 wouldMatch: function(hypothetical_uri, alist) {
   // return true if this ruleset would match the uri, assuming it were http
   // used for judging moot / inactive rulesets

   // if the ruleset is already somewhere in this applicable list, we don't
   // care about hypothetical wouldMatch questios
   if (this.name in alist.all) return false;

   this.log(DBUG,"Would " +this.name + " match " +hypothetical_uri.spec +
            "?  serial " + alist.serial);
    
   var uri = hypothetical_uri.clone();
   if (uri.scheme == "https") uri.scheme = "http";
   var urispec = uri.spec;

   if (this.ruleset_match_c && !this.ruleset_match_c.test(urispec)) 
     return false;

   for (i = 0; i < this.exclusions.length; ++i) 
     if (this.exclusions[i].pattern_c.test(urispec)) return false;

   for (i = 0; i < this.rules.length; ++i) 
     if (this.rules[i].from_c.test(urispec)) return true;
   return false;
 },

 transformURI: function(uri) {
    // If no rule applies, return null; if a rule would have applied but was
    // inactive, return 0; otherwise, return a fresh uri instance
    // for the target
    var newurl = this._apply(uri.spec);
    if (null == newurl) 
      return null;
    if (0 == newurl)
      return 0;
    var newuri = Components.classes["@mozilla.org/network/standard-url;1"].
                createInstance(CI.nsIStandardURL);
    newuri.init(CI.nsIStandardURL.URLTYPE_STANDARD, 80,
             newurl, uri.originCharset, null);
    newuri = newuri.QueryInterface(CI.nsIURI);
    return newuri;
  },

  enable: function() {
    // Enable us.
    this.prefs.setBoolPref(this.name, true);
    this.active = true;
  },

  disable: function() {
    // Disable us.
    this.prefs.setBoolPref(this.name, false);
    this.active = false;
  },

  toggle: function() {
    this.active = !this.active;
    this.prefs.setBoolPref(this.name, this.active);
  }
};

const RuleWriter = {
  addonDir: false,

  getCustomRuleDir: function() {
    var loc = "ProfD";  // profile directory
    var file =
      CC["@mozilla.org/file/directory_service;1"]
      .getService(CI.nsIProperties)
      .get(loc, CI.nsILocalFile)
      .clone();
    file.append("HTTPSEverywhereUserRules");
    // Check for existence, if not, create.
    if (!file.exists()) {
      file.create(CI.nsIFile.DIRECTORY_TYPE, 0700);
    }
    if (!file.isDirectory()) {
      // XXX: Arg, death!
    }
    return file;
  },

  getRuleDir: function() {
    if (!this.addonDir)
      try {
        // Firefox < 4
        this.addonDir = CC["@mozilla.org/extensions/manager;1"].
          getService(CI.nsIExtensionManager).
          getInstallLocation("https-everywhere@eff.org").
          getItemFile("https-everywhere@eff.org", "");
      } catch(e) {
        // Firefox >= 4 (this should not be reached)
      }
    var file = this.addonDir.clone();
    file.append("chrome");
    file.append("content");
    file.append("rules");
    if (!file.isDirectory()) {
      // XXX: Arg, death!
      this.log(WARN,"Catastrophic failure: extension directory is not a directory");
    }
    return file;
  },

  read: function(file, targets, existing_rulesets) {
    if (!file.exists())
      return null;
    if ((targets == null) && (targets != {}))
      this.log(WARN, "TARGETS IS NULL");
    var data = "";
    var fstream = CC["@mozilla.org/network/file-input-stream;1"]
        .createInstance(CI.nsIFileInputStream);
    var sstream = CC["@mozilla.org/scriptableinputstream;1"]
        .createInstance(CI.nsIScriptableInputStream);
    fstream.init(file, -1, 0, 0);
    sstream.init(fstream);

    var str = sstream.read(4096);
    while (str.length > 0) {
      data += str;
      str = sstream.read(4096);
    }

    sstream.close();
    fstream.close();
    try {
      data = data.replace(/<\?xml[^>]*\?>/, ""); 
      var xmlrules = XML(data);
    } catch(e) { // file has been corrupted; XXX: handle error differently
      this.log(WARN,"Error in XML file: " + file.path + "\n" + e);
      return null;
    }

    if (xmlrules.@name == xmlrules.@nonexistantthing) {
      this.log(DBUG, "FILE " + file.path + "is not a rulefile\n");
      return null;
    }

    var match_rl = null;
    var dflt_off = null;
    if (xmlrules.@match_rule.length() > 0) match_rl = xmlrules.@match_rule;
    if (xmlrules.@default_off.length() > 0) dflt_off = xmlrules.@default_off;
    var ret = new RuleSet(xmlrules.@name, match_rl, dflt_off);

    if (xmlrules.target.length() == 0) {
      var msg = "Error: As of v0.3.0, XML rulesets require a target domain entry,";
      msg = msg + "\nbut " + file.path + " is missing one.";
      this.log(WARN, msg);
      return null;
    }

    // see if this ruleset has the same name as an existing ruleset;
    // if so, this ruleset is ignored; DON'T add or return it.
    for (var i = 0; i < existing_rulesets.length; i++){
        if (ret.name == existing_rulesets[i].name){
           this.log(WARN, "Error: found duplicate rule name " + ret.name + " in file " + file.path);
           return null;
        }
    }

    // add this ruleset into HTTPSRules.targets with all of the applicable
    // target host indexes
    for (var i = 0; i < xmlrules.target.length(); i++) {
      var host = xmlrules.target[i].@host;
      if (!host) {
        this.log(WARN, "<target> missing host in " + file);
        continue;
      }
      if (! targets[host])
        targets[host] = [];
      targets[host].push(ret);
    }

    for (var i = 0; i < xmlrules.exclusion.length(); i++) {
      var exclusion = new Exclusion(xmlrules.exclusion[i].@pattern);
      ret.exclusions.push(exclusion);
    }

    for (var i = 0; i < xmlrules.rule.length(); i++) {
      var rule = new Rule(xmlrules.rule[i].@from,
                          xmlrules.rule[i].@to);

      ret.rules.push(rule);
    }

    for (var i = 0; i < xmlrules.securecookie.length(); i++) {
      var c_rule = new CookieRule(xmlrules.securecookie[i].@host,
                                  xmlrules.securecookie[i].@name);
      ret.cookierules.push(c_rule);
      this.log(DBUG,"Cookie rule "+ c_rule.host+ " " +c_rule.name);
    }

    return ret;
  },

  enumerate: function(dir) {
    // file is the given directory (nsIFile)
    var entries = dir.directoryEntries;
    var ret = [];
    while(entries.hasMoreElements()) {
      var entry = entries.getNext();
      entry.QueryInterface(Components.interfaces.nsIFile);
      ret.push(entry);
    }
    return ret;
  },
};



const HTTPSRules = {
  init: function() {
    try {
      this.rulesets = [];
      this.targets = {};  // dict mapping target host patterns -> lists of
                          // applicable rules
      this.rulesetsByID = {};
      var rulefiles = RuleWriter.enumerate(RuleWriter.getCustomRuleDir());
      this.scanRulefiles(rulefiles, this.targets);
      rulefiles = RuleWriter.enumerate(RuleWriter.getRuleDir());
      this.scanRulefiles(rulefiles, this.targets);
      var t,i;
      for (t in this.targets) {
        for (i = 0 ; i < this.targets[t].length ; i++) {
          this.log(INFO, t + " -> " + this.targets[t][i].name);
        }
      }

      // for any rulesets with <target host="*">
      // every URI needs to be checked against these rulesets
      // (though currently we don't ship any)
      this.global_rulesets = this.targets["*"] ? this.targets["*"] : [];

      this.rulesets.sort(
        function(r1,r2) {
            if (r1.name.toLowerCase() < r2.name.toLowerCase()) return -1;
            else return 1;
        }
      );
    } catch(e) {
      this.log(WARN,"Rules Failed: "+e);
    }
    this.log(DBUG,"Rules loaded");
    return;
  },

  scanRulefiles: function(rulefiles, targets) {
    var i = 0;
    var r = null;
    for(i = 0; i < rulefiles.length; ++i) {
      try {
        this.log(DBUG,"Loading ruleset file: "+rulefiles[i].path);
        r = RuleWriter.read(rulefiles[i], targets, this.rulesets);
        if (r != null) {
          this.rulesets.push(r);
          this.rulesetsByID[r.id] = r;
        }
      } catch(e) {
        this.log(WARN, "Error in ruleset file: " + e);
        if (e.lineNumber)
          this.log(WARN, "(line number: " + e.lineNumber + ")");
      }
    }
  },

  rewrittenURI: function(alist, input_uri) {
    // This function oversees the task of working out if a uri should be
    // rewritten, what it should be rewritten to, and recordkeeping of which
    // applicable rulesets are and aren't active.  Previously this returned
    // the new uri if there was a rewrite.  Now it returns a JS object with a
    // newuri attribute and an applied_ruleset attribute (or null if there's
    // no rewrite).
    var i = 0, userpass_present = false;
    var uri = input_uri;
    var blob = {};
    blob.newuri = null;
    if (!alist) this.log(DBUG, "No applicable list rewriting " + uri.spec);

    // Rulesets shouldn't try to parse usernames and passwords.  If we find
    // those, apply the ruleset without them and then add them back.
    // When .userPass is absent, sometimes it is false and sometimes trying
    // to read it raises an exception (probably depending on the URI type).
    try {
      if (input_uri.userPass) {
        uri = input_uri.clone()
        userpass_present = true;
        uri.userPass = null;
      } 
    } catch(e) {}

    // Get the list of rulesets that target this host
    try {
      var rs = this.potentiallyApplicableRulesets(uri.host);
    } catch(e) {
      this.log(WARN, 'Could not check applicable rules for '+uri.spec);
      return null;
    }

    // ponder each potentially applicable ruleset, working out if it applies
    // and recording it as active/inactive/moot/breaking in the applicable list
    for (i = 0; i < rs.length; ++i) {
      if (!rs[i].active) {
        if (alist && rs[i].wouldMatch(uri, alist))
          alist.inactive_rule(rs[i]);
        continue;
      } 
      blob.newuri = rs[i].transformURI(uri);
      if (blob.newuri) {
        // we rewrote the uri
        if (alist)
          if (uri.spec in https_everywhere_blacklist) 
            alist.breaking_rule(rs[i])
          else 
            alist.active_rule(rs[i]);
        if (userpass_present) blob.newuri.userPass = input_uri.userPass;
        blob.applied_ruleset = rs[i];
        return blob;
      }
      if (uri.scheme == "https" && alist) {
        // we didn't rewrite but the rule applies to this domain and the
        // requests are going over https
        if (rs[i].wouldMatch(uri, alist)) alist.moot_rule(rs[i]);
        continue;
      } 
    }
    return null;
  },


  potentiallyApplicableRulesets: function(host) {
    // Return a list of rulesets that declare targets matching this host
    var i, tmp, t;
    var results = this.global_rulesets;
    if (this.targets[host])
      results = results.concat(this.targets[host]);
    // replace each portion of the domain with a * in turn
    var segmented = host.split(".");
    for (i = 0; i < segmented.length; ++i) {
      tmp = segmented[i];
      segmented[i] = "*";
      t = segmented.join(".");
      segmented[i] = tmp;
      if (this.targets[t])
        results = results.concat(this.targets[t]);
    }
    // now eat away from the left, with *, so that for x.y.z.google.com we
    // check *.z.google.com and *.google.com (we did *.y.z.google.com above)
    for (i = 1; i < segmented.length - 2; ++i) {
      t = "*." + segmented.slice(i,segmented.length).join(".");
      if (this.targets[t])
        results = results.concat(this.targets[t]);
    }
    this.log(DBUG,"Potentially applicable rules for " + host + ":");
    for (i = 0; i < results.length; ++i)
      this.log(DBUG, "  " + results[i].name);
    return results;
  },

  shouldSecureCookie: function(applicable_list, c) {
    // Check to see if the Cookie object c meets any of our cookierule citeria
    // for being marked as secure
    //this.log(DBUG, "Testing cookie:");
    //this.log(DBUG, "  name: " + c.name);
    //this.log(DBUG, "  host: " + c.host);
    //this.log(DBUG, "  domain: " + c.domain);
    //this.log(DBUG, "  rawhost: " + c.rawHost);
    var i,j;
    var rs = this.potentiallyApplicableRulesets(c.host);
    for (i = 0; i < rs.length; ++i) {
      var ruleset = rs[i];
      if (ruleset.active) {
        for (j = 0; j < ruleset.cookierules.length; j++) {
          var cr = ruleset.cookierules[j];
          if (cr.host_c.test(c.host) && cr.name_c.test(c.name)) {
            if (applicable_list) applicable_list.active_rule(ruleset);
            this.log(INFO,"Active cookie rule " + ruleset.name);
            return true;
          }
        }
        if (ruleset.cookierules.length > 0)
          applicable_list.moot_rule(ruleset);
      } else if (ruleset.cookierules.length > 0) {
        applicable_list.inactive_rule(ruleset);
        this.log(INFO,"Inactive cookie rule " + ruleset.name);
      }
    }
    return false;
  }

};
