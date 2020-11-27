Kodisync
========

This is a hacky Node script which attempts to sync playback
of two or more Kodi instances.

It will wait until all Kodi instances have the same TV show episode loaded
(by matching show name, season number, episode number)
and then pause everybody's playback
and seek them all to the earliest position among the viewers.

From there it checks intermittently for state changes (play, pause, seek),
and attempts to sync them to the other instances.

Status
------

Rough around the edges.

The main issue is that without any kind of event-driven API we have to resort to polling.

Operation
---------

When any instance seeks while playing or presses play from a paused state,
we pause all instances temporarily,
including the one where the action took place.
The other instances are then told to seek to that position.
However, seeking in Kodi seems to be inaccurate
even when two instances are playing exactly the same file,
and so they may not be in exactly the same positions.
To mitigate this, the commands to play are staggered based on the newly-reported
position of each instance.

When an instance is paused or seeks while paused,
all other instances are told to pause and seek to that position.

Requirements
------------

It expects to talk to each [Kodi instance's JSON-RPC server](https://kodi.wiki/view/JSON-RPC_API),
so each Kodi instance must have this enabled
and you must have network access to it.

In Kodi you should only need to switch on
settings → service settings → control → allow remote control via HTTP;
no need for "application control".

You could set up an SSH tunnel or [ngrok](https://ngrok.com/)
if you need to get through firewalls or similar.

As for dependencies, you can install them with `npm install`.

Running
-------

Invoke the script and give the hosts (and ports if not 8080) of the Kodi servers
as arguments.

    node kodisync.js localhost my.friends.server:1234

It will automatically add `http://` if no protocol is given,
and will add `/jsonrpc` if no path is given.
